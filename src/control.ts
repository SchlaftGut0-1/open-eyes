import type { OverlayAction, OverlayCommand, Owner } from "./overlay.ts";

export type Draw = (cmd: OverlayCommand, owner?: Owner) => Promise<Owner>;

export type Control = {
  step(action: OverlayAction & { busy?: boolean }): Promise<Owner>;
  handoff(message: string | undefined): Promise<Owner>;
  poll(message: string | undefined): Promise<Owner>;
  owner(): Promise<Owner>;
};

export const TAKEN_BY_USER = "the user has taken control";

export function overlayControl(draw: Draw, read: () => Promise<Owner>): Control {
  return {
    step: (action) => draw({ type: "action", ...action }),
    handoff: (message) => draw(message === undefined ? { type: "show" } : { type: "handoff", message }),
    // A navigation wipes the page's memory of who is in control: claim it again for the user.
    poll: (message) => draw({ type: "claim", message }),
    owner: read,
  };
}

export function browserControl(
  send: (method: string, params: object) => Promise<{ owner: "agent" | "user" }>,
  targetId: () => string | undefined,
  draw: Draw,
): Control {
  const call = async (method: string, params: object = {}) => (await send(`OpenEyes.${method}`, { targetId: targetId(), ...params })).owner;
  return {
    async step(action) {
      const owner = await call("step", { label: action.label });
      await draw({ type: "action", ...action }, owner);
      return owner;
    },
    async handoff(message) {
      const owner = message === undefined ? await call("owner") : await call("handoff", { message });
      await draw({ type: "show" }, owner);
      return owner;
    },
    poll: () => call("owner"),
    owner: () => call("owner"),
  };
}
