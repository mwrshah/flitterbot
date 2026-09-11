import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const VM_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type VmPresence = "running" | "stopped" | "absent";
export interface VmProvider {
  presence(name: string): Promise<VmPresence>;
  fork(source: string, name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

type Run = (args: string[]) => Promise<string>;

function validateName(name: string): void {
  if (!VM_NAME.test(name)) throw new Error("Invalid exe.dev VM name");
}

export class ExeVmProvider implements VmProvider {
  private readonly run: Run;

  constructor(
    run: Run = async (args) => {
      const result = await exec(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "exe.dev", ...args],
        { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      );
      return result.stdout;
    },
  ) {
    this.run = run;
  }

  async presence(name: string): Promise<VmPresence> {
    validateName(name);
    const inventory: unknown = JSON.parse(await this.run(["ls", "--json"]));
    if (
      !inventory ||
      typeof inventory !== "object" ||
      !("vms" in inventory) ||
      !Array.isArray(inventory.vms)
    ) {
      throw new Error("Invalid exe.dev inventory; VM absence is not established");
    }
    for (const vm of inventory.vms) {
      if (!vm || typeof vm !== "object" || typeof vm.vm_name !== "string") {
        throw new Error("Incomplete exe.dev inventory; VM absence is not established");
      }
      if (vm.vm_name !== name) continue;
      if (vm.status === "running") return "running";
      if (vm.status === "stopped") return "stopped";
      throw new Error(`VM ${name} has unresolved provider state ${String(vm.status)}`);
    }
    return "absent";
  }

  async fork(source: string, name: string): Promise<void> {
    validateName(source);
    validateName(name);
    if (source === name) throw new Error("Source and destination VM must differ");
    await this.run(["cp", source, name, "--copy-tags=false", "--json"]);
  }

  async remove(name: string): Promise<void> {
    validateName(name);
    await this.run(["rm", name, "--json"]);
  }
}
