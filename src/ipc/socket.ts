import { createConnection } from "node:net";
import { join } from "node:path";

export function getGatewaySocketPath(home: string): string {
  return join(home, ".xeno", "gateway.sock");
}

export async function isSocketPathActive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);

    const finish = (value: boolean) => {
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve(value);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

export async function isGatewaySocketActive(home: string): Promise<boolean> {
  return isSocketPathActive(getGatewaySocketPath(home));
}
