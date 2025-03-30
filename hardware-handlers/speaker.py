
#!/usr/bin/env python3
import subprocess
import os
import glob
import signal
import sys

# Global variable to track current process
current_process = None

def signal_handler(sig, frame):
    """Handle Ctrl+C to gracefully terminate playback"""
    global current_process
    print("\nStopping playback...")
    if current_process and current_process.poll() is None:
        current_process.terminate()
    print("Playback stopped.")
    sys.exit(0)

def list_available_ringtones():
    """List all WAV files in the ~/ringers/ directory."""
    ringtones_dir = os.path.expanduser("~/ringers/")
    wav_files = glob.glob(os.path.join(ringtones_dir, "*.wav"))
    
    if not wav_files:
        print("No WAV files found in ~/ringers/ directory.")
        return []
    
    print("Available ringtones:")
    for i, wav_file in enumerate(wav_files):
        print(f"{i+1}. {os.path.basename(wav_file)}")
    
    return wav_files

def play_ringtone(wav_file, card_number=2):
    """Play the specified WAV file directly with maximum system volume."""
    global current_process
    
    if not os.path.exists(wav_file):
        print(f"Error: File {wav_file} not found.")
        return
    
    print(f"Playing {os.path.basename(wav_file)} on USB Audio: UACDemoV10 [UACDemoV1.0], device 0 (card 2)...")
    print("Press Ctrl+C to stop playback...")
    
    try:
        # First, try to maximize the system volume using amixer
        try:
            subprocess.run(['amixer', 'set', 'Master', '100%'], 
                          check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(['amixer', 'set', 'PCM', '100%'], 
                          check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except:
            pass
        
        # Play the WAV file directly - using the 'repeat' flag to play it multiple times
        aplay_cmd = [
            'aplay', 
            '-D', f'plughw:{card_number},0',
            '--max-file-time=20',  # Just in case the file is very long
            wav_file
        ]
        
        # Play the file 3 times in succession
        for _ in range(3):
            print("Playing... (Press Ctrl+C to stop)")
            current_process = subprocess.Popen(aplay_cmd)
            current_process.wait()
        
    except Exception as e:
        print(f"Error playing ringtone: {e}")

def main():
    """Main function to play a WAV file from ~/ringers/ at maximum system volume."""
    # Set up signal handler for clean exit
    signal.signal(signal.SIGINT, signal_handler)
    
    print("Playing ringtone test on Raspberry Pi...")
    print("Target device: USB Audio: UACDemoV10 [UACDemoV1.0], device 0 (card 2)")
    
    ringtones = list_available_ringtones()
    
    if not ringtones:
        print("No ringtones available to play.")
        return
    
    # Find the telephone ring WAV
    target_ringtone = None
    for ringtone in ringtones:
        if "telephone-ring-02.wav" in ringtone:
            target_ringtone = ringtone
            break
    
    if not target_ringtone and ringtones:
        target_ringtone = ringtones[0]  # Use first ringtone if target not found
    
    if target_ringtone:
        play_ringtone(target_ringtone)
    
    print("Test complete!")

if __name__ == "__main__":
    main()
