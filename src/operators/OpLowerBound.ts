import { IoState }		from '../io-state';
import { IoOperator }	from '../io-operator';
import { IoTimer }		from '../io-timer';


/*
 * Tracks the lower bound of a rising numeric signal and writes it to an output.
 *
 * On each rising edge (Input transitions from falling to rising), Output is written with
 * the last value before the rise began. Optionally, a debounce timer also clamps Output
 * down to Input whenever Input stays below Output for `debounceSecs`.
 */
export class OpLowerBound extends IoOperator {
	private Input:				IoState<number>;
	private Output:				IoState<number>;
	private inputWasRising						= false;
	private timer:				IoTimer | null	= null;
	private debounceMs:			number;
	private lastInputVal						= 0;

	/* `opts.debounceSecs`: if > 0, clamps Output down to Input after that many seconds of Input < Output. */
	constructor(Input: IoState<number>, Output: IoState<number>, opts: { debounceSecs: number}) {
		super([ Input ], [ Output ], []);

		this.Input		= Input;
		this.Output		= Output;
		this.debounceMs	= 1000*opts.debounceSecs;
	}

	/* Seeds lastInputVal from the current Input so the first execute() has a valid baseline. */
	protected override setup(): boolean {
		this.lastInputVal = this.Input.val;
		return true;
	}

	/*
	 * Detects the rising-edge onset (transition from falling/flat to rising) and captures
	 * the pre-rise value as the lower bound. The debounce timer, if configured, also
	 * clamps Output down to Input after `debounceMs` of continuous Input < Output.
	 */
	protected override async execute(Input: IoState<number>): Promise<void> {
		// lastInputVal
		const lastInputVal	= this.lastInputVal;
		this.lastInputVal	= Input.val;

		// debounce
		if (this.debounceMs > 0) {
			this.timer = IoTimer.clearTimer(this.timer);
			this.timer = IoTimer.setTimer({ name: 'OpLowerBound', timeoutMs: this.debounceMs, cb: async () => {
				this.timer = null;
				if (this.Output.val > this.Input.val) {
					await this.Output.write(Input.val);
				}
			}});
		}

		// inputWasRising, inputIsRising
		const inputWasRising =  this.inputWasRising;
		const inputIsRising  = (this.Input.val > lastInputVal);

		// write lower bound
		if (inputIsRising  &&  ! inputWasRising) {
			await this.Output.write(lastInputVal);
		}

		this.inputWasRising = inputIsRising;
	}
}
