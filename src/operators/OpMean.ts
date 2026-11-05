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
 * Output can be updated on every input change (event mode) or on a fixed wall-clock interval (clock mode). Event mode
 * writes only a changed output; clock mode writes every tick, so the output history has no gaps. Ticks fall on local-time
 * multiples of the interval (a 24 h clock ticks at local midnight, also across a DST change).
 * The output is always written at now (no backdating); the window it describes ends at the tick (clock mode) or at the
 * newest sample (backward event mode) or at now (forward event mode).
 *
 * Deferred ticks (`deferred: true`, clock mode only, ignored in event mode): a tick only records its timestamp T; the
 * mean for the window ending at T is computed and written when the next input sample arrives. With a backward input the
 * first sample after T covers T, so the value is exact; a forward input gives the non-deferred value, late. Several
 * ticks pending at one sample are written in order within the same millisecond: the output history (keyed by id and
 * ts) keeps only the last. Pending ticks are lost on restart.
 *
 * Start-up seeds the window from history, including the newest sample before the window start, so the first windows
 * are exact; without such a sample the oldest one is held back to the window start.
 *
 * An optional `scale` multiplies the mean (default 1.0), then an optional `precision` snaps the result before writing.
 * `precision` is a snap step, not a number of decimals: the output is `Math.round(value * scale / precision) *
 * precision` (1: whole numbers, 0.1: one decimal, 0.25: quarters, 5: multiples of 5); unset: no rounding. 0 is invalid
 * (division by zero). A step such as 0.1 can leave float noise (0.30000000000000004); whole numbers and 0.25 are exact.
 * Too coarse a step loses information (a slow discharge curve turns into plateaus).
 * Event mode compares the rounded value, so a change smaller than the step writes nothing.
 */
export class OpMean extends IoOperator {
	private readonly	Input:			IoState<number>;
	private readonly	Output:			IoState<number>;
	private readonly	periodMs:		number;										// length of the sliding window [ms]; >= 0
	private readonly	clockMs:		number | null;								// output interval [ms]; null = event mode (update on every input change)
	private readonly	precision:		number | null;								// output snap increment; null = disabled
	private readonly	scale:			number;										// output factor, applied before precision
	private readonly	deferred:		boolean;									// clock mode: ticks wait for the next input sample
	private readonly	backward:		boolean;									// false: val[i] valid from           curr.ts → next.ts (forward)
																					// true:  val[i] valid from prev.ts → curr.ts           (backward)

	private readonly	pendingTicks:	number[]							= [];	// deferred mode: tick timestamps awaiting the next sample
	private readonly	hist:	{ val: number, ts: number }[]		= [];	// log of input samples; new entries appended in execute(), old entries pruned in step()

	/*
	 * `periodSecs`: length of the sliding mean window in seconds.
	 * `clockSecs`: output interval in seconds; <= 0 enables event mode.
	 * `precision`: if set, output is rounded to the nearest multiple of this value.
	 * `backward`: if true, use backward timestamp convention (default: false).
	 * `deferred`: clock mode only; compute each tick's mean when the next input sample arrives (default: false).
	 * `scale`: output factor, default 1.0.
	 */
	constructor({ Input, Output, periodSecs, clockSecs, precision, backward, deferred, scale }: {
		Input:				IoState<number>,
		Output:				IoState<number>,
		periodSecs:			number,
		clockSecs:			number,
		precision?:			number,
		backward?:			boolean,
		deferred?:			boolean,
		scale?:				number,
	}) {
		super([ Input ], [ Output ], []);

		this.Input			= Input;
		this.Output			= Output;

		this.periodMs		= Math.round(Math.max(0, 1000*periodSecs));														// [ms/period]
		this.clockMs		= (clockSecs <= 0) ? null : Math.round(1000*clockSecs);										// [ms/clock]
		this.scale			= scale ?? 1;
		this.precision		= precision ?? null;
		this.backward		= backward  ?? false;
		this.deferred		= (deferred ?? false)  &&  this.clockMs !== null;
	}

	/* Seeds hist from historical data and, in clock mode, arms the first tick. */
	protected override async setup(): Promise<boolean> {
		const end		= this.Input.ts - 1;					// fetch history up to just before the current value
		const start		= end - this.periodMs;
		const history	= await this.Input.getHistory({ start, end, 'limit': 10000 });
		// no start: sql.0 then returns the newest row up to end, the sample that covers the window start exactly
		const before	= (await this.Input.getHistory({ end: start - 1, limit: 1 })).at(-1);

		if (before !== undefined) {
			this.hist.push({ 'ts': before.ts, 'val': before.val });
		}
		for (const { ts, val } of history) {
			this.hist.push({ ts, val });
		}

		const oldest = this.hist[0];
		if (oldest === undefined) {
			this.hist.push({ 'ts': 0, 'val': this.Input.val });	// no history: seed from current value at ts := 0
		} else if (before === undefined) {
			oldest.ts = 0;	// no sample before the window: anchor the oldest entry at ts := 0 so the window is always fully covered
		}

		if (this.clockMs !== null) {
			this.scheduleTick(this.clockMs);
		}

		return true;
	}


	/*
	 * Arms a one-shot timer for the next clock tick, which re-arms itself after step().
	 * Each tick is computed from local time at that moment (IoTimer.now(), the simulated clock in replay), so that a
	 * DST change shifts the following ticks (a 24 h clock stays on local midnight) and replay aligns past days with
	 * their own UTC offset. Rejected alternative: a fixed setInterval, which keeps the offset of the first tick.
	 */
	private scheduleTick(intervalMs: number): void {
		const now		= IoTimer.now();
		const offsetAt	= (ts: number) => new Date(ts).getTimezoneOffset()*60*1000;	// [ms], negative east of UTC

		// next local boundary strictly after now; its UTC time uses the offset valid at the boundary (two passes converge)
		const localNext	= (Math.floor((now - offsetAt(now)) / intervalMs) + 1) * intervalMs;
		let   nextTs	= localNext + offsetAt(now);
		nextTs			= localNext + offsetAt(nextTs);
		if (nextTs <= now) { nextTs = now + intervalMs; }	// DST fold: never schedule in the past

		IoTimer.setTimer({ name: this.constructor.name, timeoutMs: nextTs - now, cb: async () => {
			if (this.deferred) {
				this.pendingTicks.push(nextTs);
			} else {
				await this.step();
			}
			this.scheduleTick(intervalMs);
		}});
	}


	/* Records the new input sample and, in event mode, recomputes the mean. */
	protected override async execute(_trigger: AnyState): Promise<void> {
		this.hist.push({
			'val':		this.Input.val,
			'ts':		this.Input.ts
		});

		if (this.clockMs === null) {
			await this.step();	// event mode: recompute immediately on each input change
		} else {
			for (const tickTs of this.pendingTicks.splice(0)) {
				await this.step(tickTs);
			}
		}
	}


	/* Applies `scale`, then `precision`. */
	private finish(meanVal: number): number {
		const scaled = meanVal * this.scale;
		return (this.precision !== null) ? Math.round(scaled / this.precision) * this.precision : scaled;
	}


	/*
	 * Computes the time-weighted mean of Input over the last periodMs before `endTs` (default: the end described
	 * per mode below), writes it to Output and prunes hist entries that
	 * no later window can need. Called on every input change (event mode) or on a clock tick (clock mode).
	 * Nothing is written for periodMs 0 or an empty hist; event mode also needs two samples. Resolves after the write.
	 */
	private async step(endTs?: number): Promise<void> {
		const clock = (this.clockMs !== null);
		// clock mode: a single sample is a valid held value
		if (this.periodMs === 0 || this.hist.length === 0 || (!clock && this.hist.length < 2)) { return; }

		let integral = 0;
		let keepFrom = 0;	// index of the first entry to keep after pruning; splice(0, keepFrom) discards everything before it

		if (this.backward) {
			// Each sample val[i] is valid for the interval prev.ts → curr.ts
			// (the value arrived at curr.ts and was valid since the previous sample).
			// Integration window: [ end - periodMs, end ].
			// Event mode: end is the newest sample; nothing is extrapolated.
			// Clock mode: end is the tick and the newest value is held from its own ts to the tick; otherwise a tick
			// hours after the last sample would average a shifted window.
			const lastTs = this.hist[this.hist.length - 1]?.ts ?? 0;			// hist is not empty, see above
			const end   = endTs ?? (clock ? Math.max(lastTs, IoTimer.now()) : lastTs);
			const begin = end - this.periodMs;
			const clamp = (ts: number) => Math.max(begin, Math.min(end, ts));	// keeps timestamps within [ begin, end ]

			for (let i = (this.hist.length - 1); i >= 0; i--) {	// iterate newest → oldest
				const curr = this.hist[i];
				if (curr === undefined) { break; }				// i is within bounds; guard satisfies strict index checks

				const prev_ts = this.hist[i - 1]?.ts ?? begin;									// oldest entry has no predecessor: treat as if value was held since begin
				const from    = clamp(prev_ts);
				const until   = clamp((clock && i === this.hist.length - 1) ? end : curr.ts);	// clock mode: newest value is held to the tick
				const ms      = until - from;													// duration of this entry's contribution within the window
				if		(ms      >  0    )	{ integral += ms*curr.val;	}						// entry overlaps the window: accumulate
				else if (curr.ts <= begin)	{ keepFrom  = i;  break;	}						// entry ends before the window: keep as prev_ts anchor for the next step() call, discard everything older
			}

		} else {
			// Each sample val[i] is valid from curr.ts until the next sample arrives (next.ts).
			// Integration window: [ now - periodMs, now ]; the newest value is held until now.
			const end   = endTs ?? IoTimer.now();
			const begin = end - this.periodMs;
			const clamp = (ts: number) => Math.max(begin, Math.min(end, ts));	// keeps timestamps within [ begin, end ]

			for (let i = (this.hist.length - 1); i >= 0; i--) {	// iterate newest → oldest
				const curr = this.hist[i];
				if (curr === undefined) { break; }				// i is within bounds; guard satisfies strict index checks

				const next_ts = this.hist[i + 1]?.ts ?? end;				// newest entry has no successor: treat as if value is held until end (now)
				const from    = clamp(curr.ts);
				const until   = clamp(next_ts);
				const ms     = until - from;								// duration of this entry's contribution within the window
				if		(ms      >  0    )	{ integral += ms*curr.val;	}	// entry overlaps the window: accumulate
				else if (next_ts <= begin)	{ keepFrom = i + 1;  break;	}	// entry ends before the window: discard it and everything older
			}
		}

		this.hist.splice(0, keepFrom);	// prune: discard hist[0..keepFrom-1]; no-op when keepFrom=0

		const meanVal = integral / this.periodMs;
		const output  = this.finish(meanVal);
		if (clock || output !== this.Output.val) {	// clock mode writes every tick so the history has no gaps
			await this.Output.write(output);
		}
	}
}
