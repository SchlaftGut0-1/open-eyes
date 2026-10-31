import type { OverlayAction, OverlayCommand, Owner } from "./overlay.ts";

/** Draws on the agent's page. `owner`: who the browser says is in control, for open-eyes Browser's overlay. */
export type Draw = (cmd: OverlayCommand, owner?: Owner) => Promise<Owner>;

/** Who drives the agent's tab. Each browser keeps it in one place: the overlay, or open-eyes Browser itself. */
export type Control = {
  /** Shows the step the agent is about to take; returns who is in control. */
  step(action: OverlayAction & { busy?: boolean }): Promise<Owner>;
  /** Gives control to the user with what to do, or without a message only says who has it. */
  handoff(message: string | undefined): Promise<Owner>;
  /** Who is in control, asked every round while waiting for the user. */
  poll(message: string | undefined): Promise<Owner>;
  owner(): Promise<Owner>;
};

/** What open-eyes Browser answers when the agent acts while the user is in control (agent-panel.patch). */
export const TAKEN_BY_USER = "the user has taken control";

/** In other browsers the overlay's own buttons decide, and the overlay remembers who is in control. */
export function overlayControl(draw: Draw, read: () => Promise<Owner>): Control {
  return {
    step: (action) => draw({ type: "action", ...action }),
    handoff: (message) => draw(message === undefined ? { type: "show" } : { type: "handoff", message }),
    // A navigation wipes the page's memory of who is in control: claim it again for the user.
    poll: (message) => draw({ type: "claim", message }),
    owner: read,
  };
}

/**
 * In open-eyes Browser the browser decides: the agent can report steps and give control away
 * over its socket, and only the browser's side panel gives it back.
 */
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
