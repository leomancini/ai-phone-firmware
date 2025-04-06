import RPi.GPIO as GPIO
import time
import os
import asyncio
from typing import Callable, Optional

class Handset:
    def __init__(self, gpio_pin: int = 18):
        """Initialize the handset monitor with a customizable GPIO pin."""
        self.gpio_pin = gpio_pin
        self.last_state = None
        self._callback: Optional[Callable[[bool], None]] = None
        
        # Set up pin as input with pull-down resistor
        GPIO.setup(self.gpio_pin, GPIO.IN, pull_up_down=GPIO.PUD_DOWN)
    
    def set_callback(self, callback: Callable[[bool], None]):
        """Set a callback function to be called when handset state changes."""
        self._callback = callback
    
    def get_state(self) -> bool:
        """Get the current state of the handset (True = down, False = up)."""
        return GPIO.input(self.gpio_pin)
    
    async def monitor(self):
        """Monitor handset position and trigger callback if state changes."""
        current_state = self.get_state()
        
        if current_state != self.last_state:
            if self._callback:
                self._callback(current_state)
            self.last_state = current_state
            
        await asyncio.sleep(0.2)
    
    def cleanup(self):
        """Clean up GPIO resources."""
        GPIO.cleanup(self.gpio_pin)

async def handset_monitor_loop(handset):
    """Continuously monitor the handset."""
    while True:
        await handset.monitor()

# Example usage when run as a standalone script
if __name__ == "__main__":
    # Set up GPIO mode first
    GPIO.setmode(GPIO.BCM)
    GPIO.setwarnings(False)
    
    # Example callback function
    def handset_state_changed(state):
        print("HANDSET: ")
        if state:  # HIGH (3.3V)
            print("DOWN")
        else:  # LOW (0V)
            print("UP")
    
    # Initialize the handset
    handset = Handset()
    handset.set_callback(handset_state_changed)
    
    try:
        print("Handset Position Monitor (Press CTRL+C to exit)")
        
        # Create and run the event loop
        loop = asyncio.get_event_loop()
        loop.run_until_complete(handset_monitor_loop(handset))
    except KeyboardInterrupt:
        print("\nExiting Handset Monitor")
    finally:
        handset.cleanup()
        print("GPIO resources cleaned up")
