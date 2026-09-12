import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DangerZone } from "./DangerZone";

// AGENTS.md §4: "one poppy that nukes someone's account by accident poisons trust in the
// WHOLE ecosystem." These assert the ceremony, not the styling — every one of them is a way
// a stray click could otherwise have deleted somebody's live website.
describe("removing a website takes a deliberate confirmation", () => {
  const props = {
    siteName: "Olly Digital",
    address: "https://main.d1a2b3c4.amplifyapp.com",
    onRemove: vi.fn(),
  };

  it("never destroys on a single click — the first press only opens the dialog", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(<DangerZone {...props} onRemove={onRemove} />);

    await userEvent.click(screen.getByRole("button", { name: /remove this website…/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("names the blast radius rather than asking a bare 'are you sure?'", async () => {
    render(<DangerZone {...props} domain="ollydigital.com" onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /remove this website…/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/every file you put online/i);
    expect(dialog).toHaveTextContent(/main\.d1a2b3c4\.amplifyapp\.com/);
    expect(dialog).toHaveTextContent(/ollydigital\.com/);
    expect(dialog).toHaveTextContent(/security certificate/i);
    expect(dialog).toHaveTextContent(/can't be undone/i);
    // The half people actually worry about: what SURVIVES.
    expect(dialog).toHaveTextContent(/other websites and the files on your own computer are not touched/i);
  });

  it("leaves the domain line out when no domain is attached", async () => {
    render(<DangerZone {...props} onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /remove this website…/i }));

    expect(screen.getByRole("dialog")).not.toHaveTextContent(/security certificate/i);
  });

  it("keeps the destroy button disarmed until the site's name is typed exactly", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(<DangerZone {...props} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: /remove this website…/i }));

    const destroy = screen.getByRole("button", { name: /remove this website$/i });
    expect(destroy).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox"), "olly digital"); // wrong case
    expect(destroy).toBeDisabled();
    expect(screen.getByText(/doesn't match yet/i)).toBeInTheDocument();

    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "Olly Digital");
    expect(destroy).toBeEnabled();
    expect(screen.getByText(/the button is now on/i)).toBeInTheDocument();

    await userEvent.click(destroy);
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("focuses Cancel, so a stray Enter can't destroy anything", async () => {
    const onRemove = vi.fn();
    render(<DangerZone {...props} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: /remove this website…/i }));

    expect(screen.getByRole("button", { name: /cancel/i })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("stays out of the way while a version is still being put online", () => {
    render(<DangerZone {...props} disabled onRemove={vi.fn()} />);
    expect(screen.getByRole("button", { name: /remove this website…/i })).toBeDisabled();
    expect(screen.getByText(/once the version being put online has finished/i)).toBeInTheDocument();
  });

  it("spins on the destroy button for the whole removal, and can't be fired twice", async () => {
    // AGENTS.md §9: the single most common defect in shipped poppies is a button that looks
    // dead. Removal takes minutes (AWS takes the certificate down with it), so this one has
    // the longest opportunity to look broken.
    let finish!: () => void;
    const onRemove = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<DangerZone {...props} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: /remove this website…/i }));
    await userEvent.type(screen.getByRole("textbox"), "Olly Digital");
    await userEvent.click(screen.getByRole("button", { name: /remove this website$/i }));

    const destroy = screen.getByRole("button", { name: /removing…/i });
    expect(destroy).toHaveAttribute("aria-busy", "true");
    expect(destroy).toBeDisabled();
    expect(screen.getByText(/keeps going even if you leave this tab/i)).toBeInTheDocument();

    await userEvent.click(destroy);
    expect(onRemove).toHaveBeenCalledOnce();

    // Let it finish inside act, so the dialog's close is a state change React has settled
    // rather than one that leaks past the end of the test.
    await act(async () => finish());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a failure calmly and keeps the dialog open so the user can try again", async () => {
    const onRemove = vi.fn().mockRejectedValue(new Error("AWS isn't answering right now — try again in a minute."));
    render(<DangerZone {...props} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: /remove this website…/i }));
    await userEvent.type(screen.getByRole("textbox"), "Olly Digital");
    await userEvent.click(screen.getByRole("button", { name: /remove this website$/i }));

    expect(await screen.findByText(/AWS isn't answering right now/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Never left spinning: a rejection must clear the pending state too.
    expect(screen.getByRole("button", { name: /remove this website$/i })).toBeEnabled();
  });

  it("keeps raw AWS text out of the sentence and behind the disclosure", async () => {
    // The host bridge flattens the backend's reply into one string, so the sentence written
    // for the user arrives wrapped around the raw error. Only the sentence may reach the
    // screen (UX.md ground rule 5).
    const onRemove = vi.fn().mockRejectedValue(
      new Error('backend 500: {"message":"That website is busy right now — try again in a minute.","detail":"ThrottlingException: Rate exceeded"}'),
    );
    render(<DangerZone {...props} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: /remove this website…/i }));
    await userEvent.type(screen.getByRole("textbox"), "Olly Digital");
    await userEvent.click(screen.getByRole("button", { name: /remove this website$/i }));

    const banner = await screen.findByText(/that website is busy right now/i);
    expect(banner).not.toHaveTextContent(/ThrottlingException/);
    expect(banner.textContent).not.toMatch(/backend 500/);

    const raw = screen.getByText(/ThrottlingException: Rate exceeded/);
    expect(raw.closest("details")).not.toBeNull();
  });

  it("falls back to a calm sentence when the backend sends something unreadable", async () => {
    const onRemove = vi.fn().mockRejectedValue(new Error("backend 502: <html>Bad Gateway</html>"));
    render(<DangerZone {...props} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: /remove this website…/i }));
    await userEvent.type(screen.getByRole("textbox"), "Olly Digital");
    await userEvent.click(screen.getByRole("button", { name: /remove this website$/i }));

    expect(await screen.findByText(/something went wrong while removing this website/i)).toBeInTheDocument();
    expect(screen.getByText(/Bad Gateway/).closest("details")).not.toBeNull();
  });
});
