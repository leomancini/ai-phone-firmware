#!/usr/bin/env python3

import RPi.GPIO as GPIO
import time
import os

# Set GPIO mode to BCM
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)

# Define pins to monitor (common GPIO pins in BCM numbering)
gpio_pins = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]

# Set up all pins as inputs
for pin in gpio_pins:
    try:
        GPIO.setup(pin, GPIO.IN, pull_up_down=GPIO.PUD_DOWN)
    except:
        pass  # Skip if pin setup fails

try:
    print("Monitoring GPIO pins (Press CTRL+C to exit)")
    print("-------------------------------------------")
    
    while True:
        # Clear terminal (works on Linux/macOS)
        os.system('clear')
        
        print("GPIO Pin Monitoring")
        print("------------------")
        print("Pin (BCM) | Status")
        print("------------------")
        
        for pin in gpio_pins:
            try:
                state = GPIO.input(pin)
                status = "HIGH (3.3V)" if state else "LOW (0V)"
                print(f"GPIO {pin:2d}   | {status}")
            except:
                print(f"GPIO {pin:2d}   | Not available")
        
        print("\nPress Ctrl+C to exit")
        time.sleep(0.5)  # Update every 0.5 seconds

except KeyboardInterrupt:
    print("\nExiting GPIO monitoring")
    GPIO.cleanup()
