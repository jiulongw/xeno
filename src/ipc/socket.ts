import { join } from "node:path";

export function getGatewaySocketPath(home: string): string {
  return join(home, ".xeno", "gateway.sock");
}
