#!/usr/bin/env python3
import subprocess
import os
import glob
import signal
import sys
import asyncio
import json
import websockets
import logging
import time

# Set up logging
logging.basicConfig(level=logging.DEBUG, 
                    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('Speaker')

class Speaker:
    def __init__(self, ringtones_dir=None, card_number=2):
        """Initialize the Speaker class.
        
        Args:
            ringtones_dir (str, optional): Directory containing ringtone WAV files.
                                          Defaults to ~/ai-phone-firmware/ringtones/
            card_number (int, optional): Audio card number. Defaults to 2.
        """
        self.ringtones_dir = ringtones_dir or os.path.expanduser("~/ai-phone-firmware/ringtones/")
        self.card_number = card_number
        self.current_process = None
        self.is_ringing = False
        self.should_stop = False
        
        logger.info(f"Initialized Speaker with ringtones_dir: {self.ringtones_dir}, card_number: {self.card_number}")
        
        # Set up signal handler for clean exit
        signal.signal(signal.SIGINT, self._signal_handler)
    
    def _signal_handler(self, sig, frame):
        """Handle Ctrl+C to gracefully terminate playback"""
        logger.info("Received SIGINT signal, stopping playback...")
        print("\nStopping playback...")
        self.stop_ringtone()
        print("Playback stopped.")
        sys.exit(0)
    
    def list_available_ringtones(self):
        """List all WAV files in the ringtones directory."""
        logger.debug(f"Listing available ringtones in {self.ringtones_dir}")
        wav_files = glob.glob(os.path.join(self.ringtones_dir, "*.wav"))
        
        if not wav_files:
            logger.warning(f"No WAV files found in {self.ringtones_dir}")
            print("No WAV files found in ringtones directory.")
            return []
        
        logger.info(f"Found {len(wav_files)} ringtone files")
        print("Available ringtones:")
        for i, wav_file in enumerate(wav_files):
            print(f"{i+1}. {os.path.basename(wav_file)}")
        
        return wav_files
    
    def play_ringtone(self, wav_file, repeat=3):
        """Play the specified WAV file directly with maximum system volume.
        
        Args:
            wav_file (str): Path to the WAV file to play
            repeat (int, optional): Number of times to repeat the ringtone. Defaults to 3.
        """
        logger.info(f"Attempting to play ringtone: {wav_file}, repeat: {repeat}")
        
        if not os.path.exists(wav_file):
            logger.error(f"Ringtone file not found: {wav_file}")
            print(f"Error: File {wav_file} not found.")
            return
        
        print(f"Playing {os.path.basename(wav_file)} on USB Audio: UACDemoV10 [UACDemoV1.0], device 0 (card {self.card_number})...")
        print("Press Ctrl+C to stop playback...")
        
        try:
            # First, try to maximize the system volume using amixer
            try:
                logger.debug("Setting system volume to maximum")
                subprocess.run(['amixer', 'set', 'Master', '100%'], 
                              check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.run(['amixer', 'set', 'PCM', '100%'], 
                              check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception as e:
                logger.warning(f"Failed to set system volume: {e}")
                pass
            
            # Play the WAV file directly - using the 'repeat' flag to play it multiple times
            aplay_cmd = [
                'aplay', 
                '-D', f'plughw:{self.card_number},0',
                '--max-file-time=20',  # Just in case the file is very long
                wav_file
            ]
            
            logger.debug(f"Running aplay command: {' '.join(aplay_cmd)}")
            
            # Reset the stop flag
            self.should_stop = False
            
            # Play the file the specified number of times
            for i in range(repeat):
                if self.should_stop:
                    logger.info("Stop requested, breaking playback loop")
                    break
                    
                logger.info(f"Playing ringtone iteration {i+1}/{repeat}")
                print("Playing... (Press Ctrl+C to stop)")
                
                # Start the process
                self.current_process = subprocess.Popen(aplay_cmd)
                
                # Wait for the process to complete or until stop is requested
                while self.current_process.poll() is None:
                    if self.should_stop:
                        logger.info("Stop requested, terminating process")
                        self.current_process.terminate()
                        # Give it a moment to terminate gracefully
                        time.sleep(0.5)
                        # If it's still running, kill it
                        if self.current_process.poll() is None:
                            logger.info("Process still running, killing it")
                            self.current_process.kill()
                        break
                    time.sleep(0.1)
                
                # If stop was requested, break out of the loop
                if self.should_stop:
                    break
            
        except Exception as e:
            logger.error(f"Error playing ringtone: {e}", exc_info=True)
            print(f"Error playing ringtone: {e}")
        finally:
            # Reset the current process
            self.current_process = None
            self.should_stop = False
    
    def stop_ringtone(self):
        """Stop the current ringtone playback."""
        logger.info("Stopping current ringtone playback")
        
        # Set the stop flag
        self.should_stop = True
        
        # If there's a current process, terminate it
        if self.current_process and self.current_process.poll() is None:
            logger.debug("Terminating current process")
            try:
                # Try to terminate gracefully first
                self.current_process.terminate()
                
                # Give it a moment to terminate
                time.sleep(0.5)
                
                # If it's still running, kill it
                if self.current_process.poll() is None:
                    logger.info("Process still running, killing it")
                    self.current_process.kill()
                
                # Wait a bit more to ensure it's fully terminated
                time.sleep(0.5)
                
                # Reset the current process
                self.current_process = None
                print("Ringtone playback stopped.")
            except Exception as e:
                logger.error(f"Error stopping ringtone: {e}", exc_info=True)
        else:
            logger.debug("No active ringtone playback to stop")
            print("No active ringtone playback to stop.")
        
        # As a last resort, kill all aplay processes
        try:
            logger.info("Killing all aplay processes as a last resort")
            subprocess.run(['pkill', '-9', 'aplay'], check=False)
            print("All aplay processes killed.")
        except Exception as e:
            logger.error(f"Error killing aplay processes: {e}", exc_info=True)
    
    def play_default_ringtone(self):
        """Play the default ringtone (telephone-ring-02.wav or first available)."""
        logger.info("Playing default ringtone")
        ringtones = self.list_available_ringtones()
        
        if not ringtones:
            logger.warning("No ringtones available to play")
            print("No ringtones available to play.")
            return
        
        # Find the telephone ring WAV
        target_ringtone = None
        for ringtone in ringtones:
            if "telephone-ring-02.wav" in ringtone:
                target_ringtone = ringtone
                break
        
        if not target_ringtone and ringtones:
            logger.info(f"Default ringtone not found, using first available: {ringtones[0]}")
            target_ringtone = ringtones[0]  # Use first ringtone if target not found
        
        if target_ringtone:
            logger.info(f"Playing default ringtone: {target_ringtone}")
            self.play_ringtone(target_ringtone)
        else:
            logger.warning("No ringtone found to play")
        
        print("Test complete!")
    
    def find_ringtone_by_name(self, ringtone_name):
        """Find a ringtone file by its name.
        
        Args:
            ringtone_name (str): Name of the ringtone file (e.g., "telephone-ring-02.wav")
            
        Returns:
            str: Full path to the ringtone file, or None if not found
        """
        logger.debug(f"Looking for ringtone: {ringtone_name}")
        
        # If the name already includes the full path, return it if it exists
        if os.path.exists(ringtone_name):
            logger.info(f"Found ringtone at full path: {ringtone_name}")
            return ringtone_name
            
        # Check if the name already includes .wav extension
        if not ringtone_name.endswith('.wav'):
            ringtone_name = f"{ringtone_name}.wav"
            logger.debug(f"Added .wav extension: {ringtone_name}")
            
        # Look for the ringtone in the ringtones directory
        ringtone_path = os.path.join(self.ringtones_dir, ringtone_name)
        logger.debug(f"Checking for ringtone at: {ringtone_path}")
        
        if os.path.exists(ringtone_path):
            logger.info(f"Found ringtone at: {ringtone_path}")
            return ringtone_path
            
        # If not found, return None
        logger.warning(f"Ringtone not found: {ringtone_name}")
        return None
    
    def handle_ring_event(self, ringtone_name="telephone-ring-02.wav"):
        """Handle a ring event by playing the specified ringtone.
        
        Args:
            ringtone_name (str, optional): Name of the ringtone to play. 
                                          Defaults to "telephone-ring-02.wav".
        """
        logger.info(f"Handling ring event with ringtone: {ringtone_name}")
        
        # Find the ringtone file
        ringtone_path = self.find_ringtone_by_name(ringtone_name)
        
        if not ringtone_path:
            logger.warning(f"Ringtone '{ringtone_name}' not found. Using default.")
            print(f"Ringtone '{ringtone_name}' not found. Using default.")
            self.play_default_ringtone()
            return
            
        # Play the ringtone
        logger.info(f"Playing ringtone: {ringtone_path}")
        self.play_ringtone(ringtone_path)
    
    async def start_websocket_listener(self, host="0.0.0.0", port=8766):
        """Start a WebSocket server to listen for ring events.
        
        Args:
            host (str, optional): Host to bind to. Defaults to "0.0.0.0".
            port (int, optional): Port to bind to. Defaults to 8766.
        """
        logger.info(f"Starting WebSocket server on {host}:{port}")
        
        async def handle_websocket(websocket, path):
            client_info = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"
            logger.info(f"New WebSocket connection from {client_info}")
            
            try:
                async for message in websocket:
                    logger.debug(f"Received message from {client_info}: {message}")
                    try:
                        data = json.loads(message)
                        logger.debug(f"Parsed JSON data: {data}")
                        
                        if "event" in data:
                            if data["event"] == "ring":
                                ringtone_name = data.get("ringtone", "telephone-ring-02.wav")
                                logger.info(f"Received ring event with ringtone: {ringtone_name}")
                                
                                # Use asyncio to run the blocking play_ringtone in a separate thread
                                await asyncio.get_event_loop().run_in_executor(
                                    None, self.handle_ring_event, ringtone_name
                                )
                            elif data["event"] == "stop":
                                logger.info("Received stop event")
                                
                                # Use asyncio to run the blocking stop_ringtone in a separate thread
                                await asyncio.get_event_loop().run_in_executor(
                                    None, self.stop_ringtone
                                )
                        else:
                            logger.warning(f"Received message with unknown event: {data.get('event', 'none')}")
                    except json.JSONDecodeError as e:
                        logger.error(f"Invalid JSON received from {client_info}: {message}, error: {e}")
            except websockets.exceptions.ConnectionClosed:
                logger.info(f"WebSocket connection closed from {client_info}")
            except Exception as e:
                logger.error(f"Error handling WebSocket connection from {client_info}: {e}", exc_info=True)
        
        server = await websockets.serve(handle_websocket, host, port)
        logger.info(f"Speaker WebSocket server listening on ws://{host}:{port}")
        await server.wait_closed()


def main():
    """Main function to play a WAV file from ~/ringers/ at maximum system volume."""
    print("Playing ringtone test on Raspberry Pi...")
    print("Target device: USB Audio: UACDemoV10 [UACDemoV1.0], device 0 (card 2)")
    
    speaker = Speaker()
    speaker.play_default_ringtone()


if __name__ == "__main__":
    main()
