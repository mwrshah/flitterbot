import {
  getDaemonStatus,
  isProcessAlive,
  readDaemonPid,
  runForegroundDaemonProcess,
  startDaemonProcess,
  stopDaemonProcess,
  waitForDaemonReady,
} from "./process.ts";
import { sendWhatsAppViaDaemon } from "./send.ts";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function takeFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  args.splice(index, 2);
  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) {
    return false;
  }

  args.splice(index, 1);
  return true;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();

  switch (command) {
    case "start": {
      const pid = readDaemonPid();
      if (pid && isProcessAlive(pid)) {
        const status = await getDaemonStatus();
        printJson({ ok: true, alreadyRunning: true, daemon: status });
        return;
      }

      await startDaemonProcess();
      const daemon = await waitForDaemonReady();
      printJson({ ok: true, daemon });
      return;
    }
    case "stop": {
      const daemon = await stopDaemonProcess();
      printJson({ ok: true, status: daemon?.status ?? "stopped", daemon });
      return;
    }
    case "status": {
      const daemon = await getDaemonStatus();
      printJson({ ok: true, daemon: daemon ?? null });
      return;
    }
    case "send": {
      const contextRef = takeFlag(args, "--context");
      const text = args.join(" ").trim();
      if (!text) {
        throw new Error('Usage: autonoma-wa send "message" [--context ref]');
      }

      const result = await sendWhatsAppViaDaemon({ text, contextRef });
      printJson(result);
      process.exit(result.ok ? 0 : 1);
      return;
    }
    case "auth": {
      const pairingCode = hasFlag(args, "--pairing-code");
      const existing = await getDaemonStatus();
      if (existing) {
        await stopDaemonProcess();
      }
      const exitCode = await runForegroundDaemonProcess({ pairingCode });
      process.exit(exitCode);
      return;
    }
    default:
      console.error("Usage: autonoma-wa <start|stop|status|send|auth>");
      process.exit(1);
  }
}

await run();
