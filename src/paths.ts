import os from "node:os";
import path from "node:path";

export const FLITTERBOT_HOME = path.join(os.homedir(), ".flitterbot");
export const BLACKBOARD_PATH = path.join(FLITTERBOT_HOME, "blackboard.db");
export const FLITTERBOT_CONFIG_PATH = path.join(FLITTERBOT_HOME, "config.json");
export const WHATSAPP_CONFIG_PATH = path.join(FLITTERBOT_HOME, "whatsapp", "config.json");
