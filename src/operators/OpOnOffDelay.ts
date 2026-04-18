import { IoState }		from '../io-state';
import { IoOperator }	from '../io-operator';
import { IoTimer }		from '../io-timer';
import type { AnyState }	from '../io-state';


/*
 * Mirrors a boolean Input to Output with independent on/off delays.
 * Rising edge arms the on-timer; falling edge arms the off-timer.
 * Each edge cancels the opposing timer so rapid transitions do not double-fire.
 * setup() intentionally omitted: delays apply on adapter restart (Output stays stale until Input changes).
 */
export class OpOnOffDelay extends IoOperator {
	private Input:		IoState<boolean>;
	private Output:		IoState<boolean>;
	private onDelayMs:	number;
	private offDelayMs:	number;
	private onTimer:	IoTimer | null	= null;	// null = no timer pending
	private offTimer:	IoTimer | null	= null;	// null = no timer pending

	/* Ownership of Input and Output states is retained by the caller. */
	constructor(Input: IoState<boolean>, Output: IoState<boolean>, options: { onDelayMs: number, offDelayMs: number }) {
		super([ Input ], [ Output ], []);
		this.Input      = Input;
		this.Output     = Output;
		this.onDelayMs  = options.onDelayMs;
		this.offDelayMs = options.offDelayMs;
	}

	/*
	 * Cancels the opposing timer and re-arms the edge timer on each Input change.
	 * The guard inside each timer callback is evaluated at fire time (not arm time)
	 * so it reflects Output's actual value at the moment of the write; this prevents
	 * spurious writes and duplicate history entries if Output changed in the interim.
	 * Promise resolves after Output.write() completes.
	 */
	protected override execute(_input: AnyState): void {
		if (this.Input.val) {
			this.offTimer = IoTimer.clearTimer(this.offTimer);
			this.onTimer  = IoTimer.clearTimer(this.onTimer);
			this.onTimer  = IoTimer.setTimer({ name: `${this.constructor.name}:on`,  timeoutMs: this.onDelayMs,  cb: async () => {
				this.onTimer = null;
				if (! this.Output.val) {		// Output may have changed since timer was armed
					await this.Output.write(true);
				}
			}});

		} else {
			this.onTimer  = IoTimer.clearTimer(this.onTimer);
			this.offTimer = IoTimer.clearTimer(this.offTimer);
			this.offTimer = IoTimer.setTimer({ name: `${this.constructor.name}:off`, timeoutMs: this.offDelayMs, cb: async () => {
				this.offTimer = null;
				if (this.Output.val) {			// Output may have changed since timer was armed
					await this.Output.write(false);
				}
			}});
		}
	}
}
