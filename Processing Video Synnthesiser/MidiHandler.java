import javax.sound.midi.*;

public class MidiHandler {

  FeedbackLoop parent;
  int midiDeviceIndex;

  MidiDevice midiInputDevice;
  Transmitter midiTransmitter;
  Receiver midiReceiver;
  MidiDevice.Info[] midiInfos;

  public MidiHandler(FeedbackLoop parent, int deviceIndex) {
    this.parent = parent;
    this.midiDeviceIndex = deviceIndex;
  }

  public void init() {
    try {
      midiInfos = MidiSystem.getMidiDeviceInfo();
      parent.println("Available MIDI devices:");
      for (int i = 0; i < midiInfos.length; i++) {
        parent.println("  [" + i + "] " + midiInfos[i].getName() + " - " + midiInfos[i].getDescription());
      }

      if (midiInputDevice != null) {
        try { midiInputDevice.close(); } catch (Exception e) {}
        midiInputDevice = null;
        midiTransmitter = null;
        midiReceiver = null;
      }

      MidiDevice deviceToUse = null;
      int chosenIndex = midiDeviceIndex;

      if (chosenIndex >= 0 && chosenIndex < midiInfos.length) {
        MidiDevice candidate = MidiSystem.getMidiDevice(midiInfos[chosenIndex]);
        if (candidate.getMaxTransmitters() != 0) {
          deviceToUse = candidate;
        } else {
          parent.println("Requested MIDI device index " + chosenIndex + " has no transmitters; falling back to auto-select.");
        }
      }

      if (deviceToUse == null) {
        for (int i = 0; i < midiInfos.length; i++) {
          MidiDevice candidate = MidiSystem.getMidiDevice(midiInfos[i]);
          if (candidate.getMaxTransmitters() != 0) {
            deviceToUse = candidate;
            chosenIndex = i;
            break;
          }
        }
      }

      if (deviceToUse != null) {
        try {
          if (!deviceToUse.isOpen()) {
            deviceToUse.open();
          }
          midiInputDevice = deviceToUse;
          midiTransmitter = deviceToUse.getTransmitter();
          midiReceiver = new MidiInputReceiver();
          midiTransmitter.setReceiver(midiReceiver);
          midiDeviceIndex = chosenIndex;
          parent.println("MIDI input connected to: [" + chosenIndex + "] " + midiInfos[chosenIndex].getName());
        } catch (MidiUnavailableException e) {
          parent.println("Failed to open MIDI device [" + chosenIndex + "]: " + e.getMessage());
        } catch (Exception e) {
          parent.println("MIDI setup error: " + e.getMessage());
        }
      }

      if (midiInputDevice == null) {
        parent.println("No suitable MIDI input device found.");
      }
    } catch (Exception e) {
      parent.println("Error initialising MIDI: " + e.getMessage());
      e.printStackTrace();
    }
  }

  class MidiInputReceiver implements Receiver {
    public void send(MidiMessage message, long timeStamp) {
      if (message instanceof ShortMessage) {
        ShortMessage sm = (ShortMessage) message;
        int command = sm.getCommand();
        int data1 = sm.getData1();
        int data2 = sm.getData2();

        if (command == ShortMessage.CONTROL_CHANGE) {
          float norm = data2 / 127.0f;
          parent.handleControllerChange(data1, norm);
        } else if (command == ShortMessage.NOTE_ON && data2 > 0) {
          parent.gen_trigger = data2 / 127.0f;
        }
      }
    }

    public void close() {}
  }
}
