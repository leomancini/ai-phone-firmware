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

# Define the status file path
STATUS_FILE = '/tmp/handset_status.txt'

try:
    print("=== Handset Position Monitor (Press CTRL+C to exit) ===")
    last_state = None
    
    while True:
        # Read the state of GPIO 18
        state = GPIO.input(gpio_pin)
        
        print("\n[HANDSET] ", end='')
        # Display handset status in large text
        if not state:  # LOW (0V) - Handset is UP
            print("UP")
            if last_state != state:  # State changed to UP
                try:
                    # Write 'start' to the status file
                    with open(STATUS_FILE, 'w') as f:
                        f.write('start\n')
                    print("Handset UP - Node.js process should resume")
                except IOError as e:
                    print(f"Error writing to status file: {e}")
        else:  # HIGH (3.3V) - Handset is DOWN
            print("DOWN")
            if last_state != state:  # State changed to DOWN
                try:
                    # Write 'stop' to the status file
                    with open(STATUS_FILE, 'w') as f:
                        f.write('stop\n')
                    print("Sent stop signal to Node.js process")
                except IOError as e:
                    print(f"Error writing to status file: {e}")
        
        last_state = state
        time.sleep(0.2)  # Update every 0.2 seconds

except KeyboardInterrupt:
    print("\n=== Exiting Handset Monitor ===")
    GPIO.cleanup()
