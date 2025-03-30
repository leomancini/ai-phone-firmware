import RPi.GPIO as GPIO
import time

# Set up GPIO
GPIO.setmode(GPIO.BCM)
LED_PIN = 4
GPIO.setup(LED_PIN, GPIO.OUT)

try:
    print("LED Blink Test - Press Ctrl+C to exit")
    
    while True:
        # Turn LED on
        GPIO.output(LED_PIN, GPIO.HIGH)
        print("LED ON")
        time.sleep(1)
        
        # Turn LED off
        GPIO.output(LED_PIN, GPIO.LOW)
        print("LED OFF")
        time.sleep(1)
        
except KeyboardInterrupt:
    print("\nTest terminated")
finally:
    GPIO.cleanup()
    print("GPIO cleaned up")
