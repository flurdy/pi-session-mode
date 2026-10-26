/**
 * One exclusive slot per session for operations that must not interleave: attended publication
 * and administrative runs. Holding it is coordination inside this process, not filesystem authority.
 */
export class OperationReservation {
	#holder: string | undefined;

	get holder(): string | undefined { return this.#holder; }

	/** Returns a release function, or undefined when another operation holds the slot. */
	tryReserve(name: string): (() => void) | undefined {
		if (this.#holder !== undefined) return undefined;
		this.#holder = name;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#holder = undefined;
		};
	}
}
