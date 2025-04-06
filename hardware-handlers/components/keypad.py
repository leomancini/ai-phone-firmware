import RPi.GPIO as GPIO
import asyncio
from typing import Callable, Optional

class Keypad:
    def __init__(self, 
                 row_pins: list[int] = [26, 19, 13, 6],
                 col_pins: list[int] = [21, 20, 16],
                 keys: list[list[str]] = [
                     ['1', '2', '3'],
                     ['3', '6', '9'],
                     ['2', '5', '8'],
                     ['1', '4', '7']
                 ]):
        """Initialize the keypad with customizable pins and key layout."""
        self.row_pins = row_pins
        self.col_pins = col_pins
        self.keys = keys
        self.last_key = None
        self._callback: Optional[Callable[[str], None]] = None
        
        # Set up row pins as outputs
        for pin in self.row_pins:
            GPIO.setup(pin, GPIO.OUT)
            GPIO.output(pin, GPIO.HIGH)
        
        # Set up column pins as inputs with pull-up resistors
        for pin in self.col_pins:
            GPIO.setup(pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)
    
    def set_callback(self, callback: Callable[[str], None]):
        """Set a callback function to be called when a key is pressed."""
        self._callback = callback
    
    async def scan(self):
        """Scan the keypad and trigger callback if a key is pressed."""
        key = None
        for i, row_pin in enumerate(self.row_pins):
            GPIO.output(row_pin, GPIO.LOW)
            for j, col_pin in enumerate(self.col_pins):
                if GPIO.input(col_pin) == GPIO.LOW:
                    key = self.keys[i][j]
                    break
            GPIO.output(row_pin, GPIO.HIGH)
            if key:
                break
        
        if key and key != self.last_key:
            if self._callback:
                self._callback(key)
            self.last_key = key
            await asyncio.sleep(0.3)  # Debounce delay
        elif not key:
            self.last_key = None
        
        await asyncio.sleep(0.05)
    
    def cleanup(self):
        """Clean up GPIO resources."""
        for pin in self.row_pins + self.col_pins:
            GPIO.cleanup(pin)

async def keypad_scan_loop(keypad):
    """Continuously scan the keypad."""
    while True:
        await keypad.scan()

# Example usage when run as a standalone script
if __name__ == "__main__":
    # Set up GPIO mode first
    GPIO.setmode(GPIO.BCM)
    
    # Example callback function
    def key_pressed(key):
        print(f"Key pressed: {key}")
    
    # Initialize the keypad
    keypad = Keypad()
    keypad.set_callback(key_pressed)
    
    try:
        print("Keypad test started. Press keys on the keypad...")
        print("Press Ctrl+C to exit")
        
        # Create and run the event loop
        loop = asyncio.get_event_loop()
        loop.run_until_complete(keypad_scan_loop(keypad))
    except KeyboardInterrupt:
        print("\nExiting...")
    finally:
        keypad.cleanup()
        GPIO.cleanup()
        print("GPIO resources cleaned up") 