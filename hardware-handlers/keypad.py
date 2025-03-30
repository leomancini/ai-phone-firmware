import RPi.GPIO as GPIO
import time

# Set up GPIO mode
GPIO.setmode(GPIO.BCM)

# Keep the current pin configuration
row_pins = [26, 19, 13, 6]  # 4 rows
col_pins = [21, 20, 16]     # 3 columns

# Transposed keypad layout based on observed behavior
keys = [
    ['1', '2', '3'],
    ['3', '6', '9'],
    ['2', '5', '8'],
    ['1', '4', '7']
]

# Define row and column pins - keeping GPIO 27 for future testing
# row_pins = [4, 5, 6, 27]  # Fourth row (GPIO 27) included but not expected to work
# col_pins = [8, 9, 10]     # 3 columns

# Set up row pins as outputs
for pin in row_pins:
    GPIO.setup(pin, GPIO.OUT)
    GPIO.output(pin, GPIO.HIGH)  # Set high initially

# Set up column pins as inputs with pull-up resistors
for pin in col_pins:
    GPIO.setup(pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)

# Function to scan the keypad
def scan_keypad():
    for i, row_pin in enumerate(row_pins):
        # Set current row to low
        GPIO.output(row_pin, GPIO.LOW)
        
        # Check each column
        for j, col_pin in enumerate(col_pins):
            if GPIO.input(col_pin) == GPIO.LOW:
                return keys[i][j]  # Return the key pressed
        
        # Set the row back to high
        GPIO.output(row_pin, GPIO.HIGH)
    
    return None  # No key pressed

try:
    print("Final keypad configuration")
    print("Functional keys: 1-9")
    print("Bottom row (*, 0, #) may not work but GPIO 27 is still configured")
    print("Press Ctrl+C to exit")
    
    while True:
        key = scan_keypad()
        if key is not None:
            print(f"Key pressed: {key}")
            time.sleep(0.3)  # Debounce delay
        time.sleep(0.05)  # Small delay between scans
        
except KeyboardInterrupt:
    print("\nKeypad scanning stopped")
except Exception as e:
    print(f"An error occurred: {e}")
finally:
    GPIO.cleanup()  # Clean up GPIO on exit
    print("GPIO pins cleaned up")
