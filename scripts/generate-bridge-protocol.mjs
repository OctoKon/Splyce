import { writeFileSync } from "node:fs";
import { BRIDGE_PROTOCOL_JSON } from "@splyce/pi/contracts";

writeFileSync(
  new URL("../packages/splyce-pi/dist/bridge-protocol.json", import.meta.url),
  BRIDGE_PROTOCOL_JSON + "\n",
);
