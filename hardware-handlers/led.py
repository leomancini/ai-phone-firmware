import sys
import time
import subprocess

def run_command(command):
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

def setup_gpio():
    """Configure GPIO4 as an output."""
    print("Setting GPIO4 as output")
    return run_command("raspi-gpio set 4 op")

def led_on():
    """Turn the LED on."""
    print("Turning LED ON")
    return run_command("raspi-gpio set 4 dl")  # Set LOW to turn ON

def led_off():
    """Turn the LED off."""
    print("Turning LED OFF")
    return run_command("raspi-gpio set 4 dh")  # Set HIGH to turn OFF

def led_blink(count=5, delay=0.5):
    """Blink the LED the specified number of times."""
    print(f"Blinking LED {count} times")
    for i in range(count):
        led_on()
        time.sleep(delay)
        led_off()
        time.sleep(delay)
    return True

def check_led_status():
    """Check the current status of GPIO4."""
    try:
        result = subprocess.run("raspi-gpio get 4", shell=True, text=True, capture_output=True)
        output = result.stdout.strip()
        print(f"GPIO 4 status: {output}")
        if "level=0" in output:
            print("LED should be ON (GPIO is LOW)")
        else:
            print("LED should be OFF (GPIO is HIGH)")
        return True
    except Exception as e:
        print(f"Error checking LED status: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 led_control.py {setup|on|off|blink|status} [blink_count] [delay]")
        sys.exit(1)
    
    command = sys.argv[1].lower()
    
    if command == "setup":
        setup_gpio()
    elif command == "on":
        setup_gpio()  # Ensure pin is set as output before setting value
        led_on()
    elif command == "off":
        setup_gpio()  # Ensure pin is set as output before setting value
        led_off()
    elif command == "blink":
        setup_gpio()  # Ensure pin is set as output before setting value
        count = int(sys.argv[2]) if len(sys.argv) > 2 else 5
        delay = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
        led_blink(count, delay)
    elif command == "status":
        check_led_status()
    else:
        print(f"Unknown command: {command}")
        print("Usage: python3 led_control.py {setup|on|off|blink|status} [blink_count] [delay]")
        sys.exit(1)
