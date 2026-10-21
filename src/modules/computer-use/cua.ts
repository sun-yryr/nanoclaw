import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { embedded, ImageFormat, ScreenshotOptions } from '@trycua/cua';
import type { GuiTransport } from './manager.js';
import { GUI_MAX_IMAGE_BYTES } from './protocol.js';
import type { GuiEnvironment } from './store.js';
const exec = promisify(execFile);
/** Refuse open egress or a different container, including after operator recreation. */
export async function verifyGuiNetwork(env: GuiEnvironment): Promise<string> {
  const { stdout } = await exec('docker', ['inspect', env.container_name, env.gateway_container], {
    maxBuffer: 1024 * 1024,
    timeout: 5000,
  });
  const [gui, gateway] = JSON.parse(stdout);
  const nets = Object.keys(gui.NetworkSettings.Networks);
  if (
    !gui.State.Running ||
    gui.Config.Labels?.['nanoclaw-cua-group'] !== env.agent_group_id ||
    gui.HostConfig.Privileged ||
    gui.HostConfig.NetworkMode === 'host' ||
    gui.HostConfig.CapAdd?.includes('NET_ADMIN') ||
    nets.length !== 1 ||
    nets[0] !== env.network_name ||
    !gateway.State.Running ||
    !gateway.NetworkSettings.Networks[env.network_name]
  )
    throw new Error('GUI network mismatch');
  const info = await exec('docker', ['network', 'inspect', env.network_name], {
    maxBuffer: 1024 * 1024,
    timeout: 5000,
  });
  if (!JSON.parse(info.stdout)[0].Internal) throw new Error('GUI egress is not locked');
  return gui.NetworkSettings.Networks[env.network_name].IPAddress;
}
export async function connectGui(env: GuiEnvironment): Promise<GuiTransport> {
  const address = await verifyGuiNetwork(env);
  if (env.endpoint !== `http://${address}:3211`) throw new Error('GUI endpoint must match the isolated container');
  const token = (await fs.readFile(env.token_path, 'utf8')).trim();
  if (!token) throw new Error('Missing GUI token');
  const client = await embedded().spacesd(env.endpoint, token);
  let scale = 1;
  return {
    async observe(signal) {
      const screen = await client.screenshot(ScreenshotOptions.create({ format: ImageFormat.Jpeg, quality: 65 }), {
        signal,
      });
      const bytes = Buffer.from(screen.image);
      if (
        bytes.length > GUI_MAX_IMAGE_BYTES ||
        screen.width > 4096 ||
        screen.height > 4096 ||
        !Number.isFinite(screen.scale) ||
        screen.scale <= 0
      )
        throw new Error('GUI screenshot too large');
      scale = screen.scale;
      return { data: bytes.toString('base64'), mediaType: 'image/jpeg', width: screen.width, height: screen.height };
    },
    async act(input, signal) {
      // Full screenshots only: convert image pixels to desktop logical points.
      const x = 'x' in input ? input.x / scale : 0;
      const y = 'y' in input ? input.y / scale : 0;
      switch (input.kind) {
        case 'click':
          return client.click(x, y, { signal });
        case 'double_click':
          return client.doubleClick(x, y, { signal });
        case 'type':
          return client.typeText(input.text, { signal });
        case 'key':
          return client.hotkey(input.keys, { signal });
        case 'scroll':
          return client.scroll(input.dx, input.dy, { signal });
        case 'drag':
          return client.drag(x, y, input.toX / scale, input.toY / scale, { signal });
      }
    },
  };
}
