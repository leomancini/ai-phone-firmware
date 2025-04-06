import sys
import time
import subprocess

class LED:
    def __init__(self, pin=4):
        """Initialize LED with the specified GPIO pin."""
        self.pin = pin
        self.setup()
    
    def run_command(self, command):
        """Run a shell command and return the output."""
        try:
            result = subprocess.run(command, shell=True, text=True, capture_output=True)
            if result.returncode != 0:
                print(f"Command failed: {result.stderr}")
                return False
            return True
        except Exception as e:
            print(f"Error running command: {e}")
            return False
    
    def setup(self):
        """Configure GPIO pin as an output."""
        print(f"Setting GPIO{self.pin} as output")
        return self.run_command(f"raspi-gpio set {self.pin} op")
    
    def on(self):
        """Turn the LED on."""
        print("Turning LED ON")
        return self.run_command(f"raspi-gpio set {self.pin} dl")  # Set LOW to turn ON
    
    def off(self):
        """Turn the LED off."""
        print("Turning LED OFF")
        return self.run_command(f"raspi-gpio set {self.pin} dh")  # Set HIGH to turn OFF
    
    def blink(self, count=5, delay=0.5):
        """Blink the LED the specified number of times."""
        print(f"Blinking LED {count} times")
        for i in range(count):
            self.on()
            time.sleep(delay)
            self.off()
            time.sleep(delay)
        return True
    
    def status(self):
        """Check the current status of the GPIO pin."""
        try:
            result = subprocess.run(f"raspi-gpio get {self.pin}", shell=True, text=True, capture_output=True)
            output = result.stdout.strip()
            print(f"GPIO {self.pin} status: {output}")
            if "level=0" in output:
                print("LED should be ON (GPIO is LOW)")
                return True
            else:
                print("LED should be OFF (GPIO is HIGH)")
                return False
        except Exception as e:
            print(f"Error checking LED status: {e}")
            return False

# Command-line interface for testing
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 led.py {setup|on|off|blink|status} [blink_count] [delay]")
        sys.exit(1)
    
    led = LED()
    command = sys.argv[1].lower()
    
    if command == "setup":
        led.setup()
    elif command == "on":
        led.on()
    elif command == "off":
        led.off()
    elif command == "blink":
        count = int(sys.argv[2]) if len(sys.argv) > 2 else 5
        delay = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
        led.blink(count, delay)
    elif command == "status":
        led.status()
    else:
        print(f"Unknown command: {command}")
        print("Usage: python3 led.py {setup|on|off|blink|status} [blink_count] [delay]")
        sys.exit(1)
