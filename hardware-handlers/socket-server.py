import asyncio
import websockets
import RPi.GPIO as GPIO
import json
from typing import Set
import socket
import logging
import subprocess
import os
import sys
import signal
from components.keypad import Keypad
from components.handset import Handset
from components.led import LED
from components.speaker import Speaker

# Add the parent directory to the Python path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Set up logging
logging.basicConfig(level=logging.INFO, 
                    format='%(asctime)s - %(message)s')
logger = logging.getLogger('SocketServer')

# Suppress debug logs from websockets
logging.getLogger('websockets').setLevel(logging.INFO)
logging.getLogger('asyncio').setLevel(logging.INFO)

# Set GPIO mode to BCM
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)

# Store connected clients
connected_clients: Set[websockets.WebSocketServerProtocol] = set()

# Store current ringtone process
current_ringtone_process = None

def get_local_ip():
    """Get the local IP address of the machine."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except Exception:
        return "127.0.0.1"

async def broadcast_event(event_type: str, data: dict):
    """Broadcast any event to all connected clients."""
    if connected_clients:
        message = json.dumps({
            "event": event_type,
            **data
        })
        logger.info(f"EVENT OUT: {event_type} {json.dumps(data)}")
        await asyncio.gather(
            *[client.send(message) for client in connected_clients]
        )

async def monitor_keypad(keypad: Keypad):
    """Monitor keypad and broadcast key presses."""
    while True:
        await keypad.scan()

async def monitor_handset(handset: Handset):
    """Monitor handset position and broadcast changes."""
    while True:
        await handset.monitor()

def kill_aplay():
    """Kill all aplay processes using direct system commands."""
    try:
        # Get all process IDs for aplay
        pids = subprocess.check_output(['pgrep', 'aplay']).decode().strip().split('\n')
        
        # Kill each process individually with SIGKILL
        for pid in pids:
            try:
                pid = int(pid)
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass  # Process already gone
            except ValueError:
                pass  # Invalid PID
            except Exception as e:
                logger.error(f"Error killing process {pid}: {e}")
                
        # Double check with a direct system kill
        subprocess.run(['sudo', 'killall', '-9', 'aplay'], check=False)
        
    except subprocess.CalledProcessError:
        pass  # No aplay processes found
    except Exception as e:
        logger.error(f"Error in kill_aplay: {e}")
        try:
            # Last resort: direct system command
            subprocess.run(['sudo', 'pkill', '-9', 'aplay'], check=False)
        except:
            pass

async def play_ringtone(speaker: Speaker, ringtone_name: str):
    """Play ringtone in a way that can be stopped."""
    global current_ringtone_process
    
    # Kill any existing processes
    if current_ringtone_process:
        try:
            current_ringtone_process.terminate()
            await asyncio.sleep(0.1)
            if current_ringtone_process.poll() is None:
                current_ringtone_process.kill()
        except:
            pass
    
    kill_aplay()
    
    # Start new ringtone
    logger.info(f"EVENT: Playing ringtone {ringtone_name}")
    current_ringtone_process = await asyncio.create_subprocess_exec(
        'aplay',
        '-D', f'plughw:2,0',
        '--max-file-time=20',
        os.path.join(speaker.ringtones_dir, ringtone_name),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    
    # Create a background task to monitor the process
    async def monitor_process():
        global current_ringtone_process
        try:
            await current_ringtone_process.wait()
            logger.info(f"EVENT: Ringtone finished playing {ringtone_name}")
        except asyncio.CancelledError:
            if current_ringtone_process:
                current_ringtone_process.terminate()
                await asyncio.sleep(0.1)
                if current_ringtone_process.poll() is None:
                    current_ringtone_process.kill()
            raise
        finally:
            current_ringtone_process = None
    
    # Start the monitoring task in the background
    asyncio.create_task(monitor_process())

async def stop_ringtone(reason="manual"):
    """Stop the current ringtone."""
    global current_ringtone_process
    
    if current_ringtone_process:
        logger.info("EVENT: Stopping ringtone")
        try:
            current_ringtone_process.terminate()
            await asyncio.sleep(0.1)
            if current_ringtone_process.poll() is None:
                current_ringtone_process.kill()
            current_ringtone_process = None
        except:
            pass
        
        # Emit a special event for ringtone stopped
        await broadcast_event("ringtone_stopped", {"reason": reason})
    
    kill_aplay()

async def handle_handset_state(state):
    """Handle handset state changes and stop ringtone when picked up."""
    # Broadcast the handset state change
    await broadcast_event("handset_state", {"state": "down" if state else "up"})
    
    # If handset is picked up (state is False), stop the ringtone
    if not state:
        # Check if there's a ringtone playing before stopping it
        if current_ringtone_process:
            await stop_ringtone(reason="handset_pickup")

async def handle_client(websocket: websockets.WebSocketServerProtocol, handset: Handset, keypad: Keypad, led: LED, speaker: Speaker):
    """Handle individual client connections."""
    client_info = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"
    
    try:
        connected_clients.add(websocket)
        
        # Send initial states silently
        handset_state = handset.get_state()
        await websocket.send(json.dumps({
            "event": "handset_state",
            "state": "down" if handset_state else "up"
        }))
        
        # Send initial LED state silently
        led_state = led.status()
        await websocket.send(json.dumps({
            "event": "led_state",
            "state": "on" if led_state else "off"
        }))
        
        # Handle incoming messages
        async for message in websocket:
            try:
                data = json.loads(message)
                
                if "event" in data:
                    event_type = data["event"]
                    logger.info(f"EVENT IN: {event_type} {json.dumps({k:v for k,v in data.items() if k != 'event'})}")
                    
                    if event_type == "led_on":
                        led.on()
                        await broadcast_event("led_state", {"state": "on"})
                    elif event_type == "led_off":
                        led.off()
                        await broadcast_event("led_state", {"state": "off"})
                    elif event_type == "led_status":
                        # Respond only to the requesting client
                        led_state = led.status()
                        await websocket.send(json.dumps({
                            "event": "led_state",
                            "state": "on" if led_state else "off"
                        }))
                    elif event_type == "ring":
                        # Handle ring event
                        ringtone_name = data.get("ringtone", "telephone-ring-02.wav")
                        await play_ringtone(speaker, ringtone_name)
                        
                    elif event_type == "stop":
                        # Handle stop event - immediately kill all aplay processes
                        await stop_ringtone(reason="manual_stop")
                        
                    elif event_type == "open_ai_realtime_client_message":
                        # Handle client_message event - broadcast to all clients
                        message_data = {
                            "data": data.get("message", "")
                        }
                        await broadcast_event("ai_realtime_client_message", message_data)
                        
            except json.JSONDecodeError as e:
                logger.error(f"Invalid JSON received: {message}")
        
        await websocket.wait_closed()
        
    except Exception as e:
        logger.error(f"Error handling client: {e}")
    finally:
        connected_clients.remove(websocket)

async def main():
    """Main function to start the WebSocket server."""
    local_ip = get_local_ip()
    
    # Initialize components
    keypad = Keypad()
    handset = Handset()
    led = LED()
    speaker = Speaker()
    
    # Set up callbacks
    keypad.set_callback(lambda key: asyncio.create_task(
        broadcast_event("keypad_press", {"key": key})
    ))
    
    handset.set_callback(lambda state: asyncio.create_task(
        handle_handset_state(state)
    ))
    
    # Start monitoring tasks
    handset_task = asyncio.create_task(monitor_handset(handset))
    keypad_task = asyncio.create_task(monitor_keypad(keypad))
    
    # Create a handler factory that captures the handset, keypad, led, and speaker variables
    async def handler(websocket):
        await handle_client(websocket, handset, keypad, led, speaker)
    
    async with websockets.serve(handler, "0.0.0.0", 8765):
        logger.info(f"Server ready at ws://{local_ip}:8765")
        # Turn on LED to indicate server is running
        led.on()
        await broadcast_event("led_state", {"state": "on"})
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server shutting down")
        # Make sure to stop any playing ringtone
        kill_aplay()  # Kill immediately without async
    finally:
        GPIO.cleanup()
