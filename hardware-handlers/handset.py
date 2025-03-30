import RPi.GPIO as GPIO
import time
import os

# Set GPIO mode to BCM
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)

# Define the pin to monitor
gpio_pin = 18

# Set up pin as input with pull-down resistor
GPIO.setup(gpio_pin, GPIO.IN, pull_up_down=GPIO.PUD_DOWN)

try:
    print("Handset Position Monitor (Press CTRL+C to exit)")
    
    while True:
        # Clear terminal
        os.system('clear')
        
        # Read the state of GPIO 18
        state = GPIO.input(gpio_pin)
        
        print("HANDSET: ")
        # Display handset status in large text
        if state:  # HIGH (3.3V)
            print("DOWN")
        else:  # LOW (0V)
            print("UP")
        
        print("Press Ctrl+C to exit")
        time.sleep(0.2)  # Update every 0.2 seconds

except KeyboardInterrupt:
    print("\nExiting Handset Monitor")
    GPIO.cleanup()
