import { IoState }		from '../io-state';
import { IoOperator }	from '../io-operator';
import { IoTimer }		from '../io-timer';
import type { AnyState }	from '../io-state';


/*
 * Computes the time-weighted mean of a numeric input over a sliding window and writes the result to an output.
 *
 * Two timestamp conventions are supported:
 *   - forward  (default): each sample is valid from its own timestamp until the next sample arrives.
 *   - backward:           each sample is valid from the previous sample's timestamp up to its own timestamp.
 *
 * Output can be updated on every input change (event mode) or on a fixed wall-clock interval (clock mode).
 * An optional precision snaps the output to the nearest multiple before writing.
 */
export class OpMean extends IoOperator {
	private readonly	Input:			IoState<number>;
	private readonly	Output:			IoState<number>;
	private readonly	periodMs:		number;				// length of the sliding window [ms]; >= 0
	private readonly	clockMs:		number | null;		// output interval [ms]; null = event mode (update on every input change)
	private readonly	precision:		number | null;		// output snap increment; null = disabled
	private readonly	backward:		boolean;			// false: val[i] valid from           curr.ts → next.ts (forward)
																// true:  val[i] valid from prev.ts → curr.ts           (backward)

	private readonly	hist:	{ val: number, ts: number }[]		= [];	// log of input samples; new entries appended in execute(), old entries pruned in step()

	/*
	 * `periodSecs`: length of the sliding mean window in seconds.
	 * `clockSecs`: output interval in seconds; <= 0 enables event mode.
	 * `precision`: if set, output is rounded to the nearest multiple of this value.
	 * `backward`: if true, use backward timestamp convention (default: false).
	 */
	constructor({ Input, Output, periodSecs, clockSecs, precision, backward }: {
		Input:				IoState<number>,
		Output:				IoState<number>,
		periodSecs:			number,
		clockSecs:			number,
		precision?:			number,
		backward?:			boolean,
	}) {
		super([ Input ], [ Output ], []);

		this.Input			= Input;
		this.Output			= Output;

		this.periodMs		= Math.round(Math.max(0, 1000*periodSecs));					// [ms/period]
		this.clockMs		= (clockSecs <= 0) ? null : Math.round(1000*clockSecs);		// [ms/clock ]
		this.precision		= precision ?? null;
		this.backward		= backward  ?? false;
	}

	/* Seeds hist from historical data and starts the clock timer if in clock mode. */
	protected override async setup(): Promise<boolean> {
		const end		= this.Input.ts - 1;						// fetch history up to just before the current value
		const start		= end - this.periodMs;
		const history	= await this.Input.getHistory({ start, end, 'limit': 10000 });
		if (history.length === 0) {
			this.hist.push({ 'ts': 0, 'val': this.Input.val });		// no history: seed from current value at ts := 0

		} else {
			let oldest: { val: number, ts: number } | undefined;
			for (const { ts, val } of history) {
				const entry = { ts, val };
				oldest ??= entry;
				this.hist.push(entry);
			}
			if (oldest !== undefined) {
				oldest.ts = 0;										// anchor oldest entry at ts := 0 so the window is always fully covered
			}
		}

		if (this.clockMs !== null) {
			const tzOffsetMs = (new Date()).getTimezoneOffset()*60*1000;					// e.g. -60*60*1000 for UTC+1
			const intervalMs = this.clockMs;
			const timeoutMs  = intervalMs - ((IoTimer.now() - tzOffsetMs) % intervalMs);		// align first tick to the next wall-clock boundary
			IoTimer.setTimer({ name: this.constructor.name, timeoutMs, intervalMs, cb: async () => {
				await this.step();
			}});
		}

		return true;
	}


	/* Records the new input sample and, in event mode, immediately recomputes the mean. */
	protected override async execute(_trigger: AnyState): Promise<void> {
		this.hist.push({
			'val':		this.Input.val,
			'ts':		this.Input.ts
		});

		if (this.clockMs === null) {
			await this.step();		// event mode: recompute immediately on each input change
		}
	}


	/*
	 * Compute the time-weighted mean of Input over the last periodMs and write it to Output.
	 * Called on every input change (event mode) or on a wall-clock interval (clock mode).
	 */
	private async step(): Promise<void> {
		if (this.periodMs === 0 || this.hist.length < 2) { return; }

		let integral = 0;
		let keepFrom = 0;		// index of the first entry to keep after pruning; splice(0, keepFrom) discards everything before it

		if (this.backward) {
			// Each sample val[i] is considered valid for the interval  prev_ts → curr.ts
			// (i.e. the value "arrived" at curr.ts and was valid since the previous sample).
			// Integration window: [ last.ts - periodMs, last.ts ]
			// The window closes at the most recent sample so that data beyond last.ts is not extrapolated.
			// hist.length >= 2 is guaranteed above, so hist[last] is always defined; ?? 0 is unreachable.
			const end   = this.hist[this.hist.length - 1]?.ts ?? 0;
			const begin = end - this.periodMs;
			const clamp = (ts: number) => Math.max(begin, Math.min(end, ts));	// keeps timestamps within [ begin, end ]

			for (let i = (this.hist.length - 1); i >= 0; i--) {		// iterate newest → oldest
				const curr = this.hist[i];
				if (curr === undefined) { break; }					// i is within bounds; guard satisfies strict index checks

				const prev_ts = this.hist[i - 1]?.ts ?? begin;		// oldest entry has no predecessor: treat as if value was held since begin
				const from    = clamp(prev_ts);						// clamp interval start into window
				const until   = clamp(curr.ts);						// clamp interval end   into window
				const ms      = until - from;						// duration of this entry's contribution within the window
				if		(ms      >  0    )	{ integral += ms*curr.val;	}	// entry overlaps the window: accumulate
				else if (curr.ts <= begin)	{ keepFrom  = i;  break;	}	// entry ends before the window: keep as prev_ts anchor for the next step() call, discard everything older
			}

		} else {
			// Each sample val[i] is considered valid from curr.ts until the next sample arrives (next_ts).
			// (i.e. the value is valid from the moment it was set until it is overwritten.)
			// Integration window: [ now - periodMs, now ]
			// The window extends to the present so the most recent value is held until now.
			const end   = IoTimer.now();
			const begin = end - this.periodMs;
			const clamp = (ts: number) => Math.max(begin, Math.min(end, ts));	// keeps timestamps within [ begin, end ]

			for (let i = (this.hist.length - 1); i >= 0; i--) {		// iterate newest → oldest
				const curr = this.hist[i];
				if (curr === undefined) { break; }					// i is within bounds; guard satisfies strict index checks

				const next_ts = this.hist[i + 1]?.ts ?? end;		// newest entry has no successor: treat as if value is held until end (now)
				const from    = clamp(curr.ts);						// clamp interval start into window
				const until   = clamp(next_ts);						// clamp interval end   into window
				const ms      = until - from;						// duration of this entry's contribution within the window
				if		(ms      >  0    )	{ integral += ms*curr.val;	}	// entry overlaps the window: accumulate
				else if (next_ts <= begin)	{ keepFrom = i + 1;  break;	}	// entry ends before the window: discard it and everything older
			}
		}

		this.hist.splice(0, keepFrom);		// prune: discard hist[0..keepFrom-1]; no-op when keepFrom=0

		const meanVal = integral / this.periodMs;											// time-weighted mean = integral / window length
		const output  = (this.precision !== null) ? Math.round(meanVal / this.precision) * this.precision : meanVal;	// snap to precision if set
		if (output !== this.Output.val) {
			await this.Output.write(output);
		}
	}
}
