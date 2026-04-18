import { IoState }		from '../io-state';
import { IoOperator }	from '../io-operator';
import { IoTimer }		from '../io-timer';


/*
 * Mirrors a boolean Input to Output with duty-cycle-controlled delays.
 *
 * When Input switches ON, Output is delayed until the resulting duty cycle would be at
 * least `dutyCycleOnMin`. When Input switches OFF, Output is delayed until the duty
 * cycle would drop to `dutyCycleOffMax`. This prevents chattering and enforces minimum
 * on/off durations relative to the observed switching period.
 */
export class OpFollowSwitch extends IoOperator {
	private Input:		IoState<boolean>;
	private Output:		IoState<boolean>;
	private timer:		IoTimer | null		= null;
	private dutyCycleOnMin;					// switch dst ON  only if currDutyCyle >= dutyCycleOnMin
	private	dutyCycleOffMax;				// switch dst OFF only if currDutyCyle <= dutyCycleOffMax
	private lastChangeTs					= 0;

	constructor(Input: IoState<boolean>, Output: IoState<boolean>, options: { dutyCycleOnMin?: number, dutyCycleOffMax?: number } = {}) {
		super([ Input ], [ Output ], []);
		if (!Output.writable)  throw new Error(`${this.constructor.name}: constructor(): ${Output.stateId}: must be writable`);

		this.Input  = Input;
		this.Output = Output;

		this.dutyCycleOnMin  = Math.max(0.000, Math.min(0.999, options.dutyCycleOnMin  ?? 0.0));
		this.dutyCycleOffMax = Math.max(0.001, Math.min(1.000, options.dutyCycleOffMax ?? 1.0));
	}

	/* Seeds lastChangeTs from the current Input timestamp so the first execute() has a valid interval. */
	protected override setup(): boolean {
		this.lastChangeTs = this.Input.ts;
		return true;
	}

	/*
	 * Schedules a delayed write to Output based on the duty-cycle thresholds.
	 * A pending timer is always cancelled first so only the latest transition is applied.
	 */
	protected override execute(Input: IoState<boolean>): void {
		// lastChangeTs
		const lastChangeTs	= this.lastChangeTs;
		this. lastChangeTs	= Input.ts;

		// nextDstVal, timer
		const nextDstVal = Input.val;
		this.timer = IoTimer.clearTimer(this.timer);

		if (this.Output.val !== nextDstVal) {
			let waitMs = (Input.ts - lastChangeTs);

			// src switched ON and curr dst val is OFF?
			if (nextDstVal) {
				// waitOnMs / (src.ts - src.last.ts + waitOnMs) >= dutyCycleOnMin		// 0 <= dutyCycleOnMin <= 0.999
				waitMs *= this.dutyCycleOnMin/(1 - this.dutyCycleOnMin);				// 0 <= waitOnMs       <=   999 * ...

			// src switched OFF and dst is ON?
			} else {
				// (src.ts - src.last.ts) / (src.ts - src.last.ts + waitOffMs) <= dutyCycleOffMax		// 0.001 <= dutyCycleOffMax <= 1
				waitMs *= (1 - this.dutyCycleOffMax)/this.dutyCycleOffMax;								// 0     <= waitOffMs       <= 999 * ...
			}

			this.timer = IoTimer.setTimer({ name: this.constructor.name, timeoutMs: waitMs, cb: async () => {
				this.timer = null;
				await this.Output.write(nextDstVal);
			}});
		}
	}
}
