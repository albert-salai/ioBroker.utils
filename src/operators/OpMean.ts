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
 * An optional `scale` multiplies the mean (default 1.0), then an optional precision snaps the output to the nearest
 * multiple before writing.
 *
 * Rate mode (`rate`): the input is a monotonic counter (e.g. kWh) and the output is its mean rate per hour (kWh -> kW;
 * with `scale: 1000` W). Power is taken as constant between two counter steps, so the counter is linear between them
 * and rates over consecutive windows add up to the counter difference. An unchanged value (a rewrite of the state,
 * which moves only ts) is skipped and a falling counter (replaced meter) restarts the series, so neither writes a 0
 * or negative rate. `backward` is ignored.
 *   - `periodSecs` 0: the mean rate between the last two input changes, written with every change.
 *   - `periodSecs` > 0: the mean rate over the sliding window (event or clock mode as above), computed from the
 *     counter, not from earlier outputs. Clock mode holds the power of the last step until the tick, an estimate for
 *     the time since that step. A window not yet covered by samples is shortened to the first sample.
 */
export class OpMean extends IoOperator {
	private readonly	Input:			IoState<number>;
	private readonly	Output:			IoState<number>;
	private readonly	periodMs:		number;										// length of the sliding window [ms]; >= 0
	private readonly	clockMs:		number | null;								// output interval [ms]; null = event mode (update on every input change)
	private readonly	precision:		number | null;								// output snap increment; null = disabled
	private readonly	scale:			number;										// output factor, applied before precision
	private readonly	rate:			boolean;									// rate mode: see class comment
	private				prevRaw:		{ val: number, ts: number } | undefined;	// rate mode: previous counter step
	private readonly	backward:		boolean;									// false: val[i] valid from           curr.ts → next.ts (forward)
																					// true:  val[i] valid from prev.ts → curr.ts           (backward)

	private readonly	hist:	{ val: number, ts: number }[]		= [];	// log of input samples; new entries appended in execute(), old entries pruned in step()

	/*
	 * `periodSecs`: length of the sliding mean window in seconds.
	 * `clockSecs`: output interval in seconds; <= 0 enables event mode.
	 * `precision`: if set, output is rounded to the nearest multiple of this value.
	 * `backward`: if true, use backward timestamp convention (default: false).
	 * `scale`: output factor, default 1.0.
	 * `rate`: if true, rate mode (default: false), see class comment.
	 */
	constructor({ Input, Output, periodSecs, clockSecs, precision, backward, scale, rate }: {
		Input:				IoState<number>,
		Output:				IoState<number>,
		periodSecs:			number,
		clockSecs:			number,
		precision?:			number,
		backward?:			boolean,
		scale?:				number,
		rate?:				boolean,
	}) {
		super([ Input ], [ Output ], []);

		this.Input			= Input;
		this.Output			= Output;

		this.periodMs		= Math.round(Math.max(0, 1000*periodSecs));														// [ms/period]
		this.rate			= rate ?? false;
		this.clockMs		= (clockSecs <= 0 || (this.rate && this.periodMs === 0)) ? null : Math.round(1000*clockSecs);	// [ms/clock]
		this.scale			= scale ?? 1;
		this.precision		= precision ?? null;
		this.backward		= backward  ?? false;
	}

	/*
	 * Rate mode: seeds prevRaw from the newest counter step before the current value.
	 * Otherwise: seeds hist from historical data and, in clock mode, arms the first tick.
	 */
	protected override async setup(): Promise<boolean> {
		if (this.rate && this.periodMs === 0) {
			// no start: sql.0 then returns the newest row up to end
			const rows = await this.Input.getHistory({ end: this.Input.ts - 1, limit: 1 });
			this.prevRaw = rows.at(-1);
			return true;
		}

		if (this.rate) {
			// the window needs the sample before its start too (no start: sql.0 returns the newest row up to end)
			const end		= this.Input.ts - 1;
			const start		= end - this.periodMs;
			const rows		= await this.Input.getHistory({ start, end, limit: 10000 });
			const before	= await this.Input.getHistory({ end: start - 1, limit: 1 });
			this.hist.push(...before.slice(-1), ...rows);
			if (this.clockMs !== null) {
				this.scheduleTick(this.clockMs);
			}
			return true;
		}

		const end		= this.Input.ts - 1;					// fetch history up to just before the current value
		const start		= end - this.periodMs;
		const history	= await this.Input.getHistory({ start, end, 'limit': 10000 });
		if (history.length === 0) {
			this.hist.push({ 'ts': 0, 'val': this.Input.val });	// no history: seed from current value at ts := 0

		} else {
			let oldest: { val: number, ts: number } | undefined;
			for (const { ts, val } of history) {
				const entry = { ts, val };
				oldest ??= entry;
				this.hist.push(entry);
			}
			if (oldest !== undefined) {
				oldest.ts = 0;	// anchor oldest entry at ts := 0 so the window is always fully covered
			}
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
			await this.step();
			this.scheduleTick(intervalMs);
		}});
	}


	/* Rate mode: writes the rate. Otherwise records the new input sample and, in event mode, recomputes the mean. */
	protected override async execute(_trigger: AnyState): Promise<void> {
		if (this.rate && this.periodMs === 0) {
			await this.stepRate();
			return;
		}

		if (this.rate) {
			const last = this.hist.at(-1);
			if (this.Input.val === last?.val) { return; }						// rewrite of the state: only ts moved
			if (last && this.Input.val < last.val) { this.hist.length = 0; }	// meter replaced
			this.hist.push({ val: this.Input.val, ts: this.Input.ts });
			if (this.clockMs === null) { await this.stepWindow(); }
			return;
		}

		this.hist.push({
			'val':		this.Input.val,
			'ts':		this.Input.ts
		});

		if (this.clockMs === null) {
			await this.step();	// event mode: recompute immediately on each input change
		}
	}


	/*
	 * Rate mode: writes the mean rate per hour between the previous and the current counter step. Nothing is written
	 * for the first step, an unchanged or falling counter, or time that does not advance. Resolves after the write.
	 */
	private async stepRate(): Promise<void> {
		const prev = this.prevRaw;
		if (this.Input.val === prev?.val) { return; }

		const curr = { val: this.Input.val, ts: this.Input.ts };
		this.prevRaw = curr;
		if (!prev || curr.val < prev.val || curr.ts <= prev.ts) { return; }

		const ratePerHour = (curr.val - prev.val) * 3600*1000 / (curr.ts - prev.ts);
		await this.Output.write(this.finish(ratePerHour));
	}


	/*
	 * Rate mode with a window: writes the mean rate per hour over [end - periodMs, end] from the counter samples in
	 * `hist` (end: the tick in clock mode, else the newest sample). Nothing is written without a power to extend the
	 * counter with, or for an empty window. Prunes samples before the one that covers the window start.
	 * Resolves after the write.
	 */
	private async stepWindow(): Promise<void> {
		// phase: window bounds; the power of the last interval needs two samples
		const first	= this.hist[0];
		const last	= this.hist.at(-1);
		const prev	= this.hist.at(-2);
		if (!first || !last || !prev) { return; }

		const end	= (this.clockMs !== null) ? Math.max(last.ts, IoTimer.now()) : last.ts;
		const begin	= Math.max(end - this.periodMs, first.ts);
		if (end <= begin) { return; }

		// phase: counter at t, linear between samples, beyond the newest sample with the power of the last interval
		const kwhPerMs	= (last.val - prev.val) / (last.ts - prev.ts);
		const counterAt	= (t: number): number => {
			if (t >= last.ts) { return last.val + kwhPerMs * (t - last.ts); }
			for (let i = this.hist.length - 1; i > 0; i--) {
				const a = this.hist[i - 1];
				const b = this.hist[i];
				if (a && b && a.ts <= t && b.ts > a.ts) { return a.val + ((b.val - a.val) * (t - a.ts)) / (b.ts - a.ts); }
			}
			return first.val;
		};

		// phase: rate over the window
		const ratePerHour = ((counterAt(end) - counterAt(begin)) * 3600*1000) / (end - begin);

		// phase: prune, keeping the sample that covers the next window start
		let keepFrom = 0;
		while (keepFrom + 1 < this.hist.length && (this.hist[keepFrom + 1]?.ts ?? Infinity) <= end - this.periodMs) { keepFrom++; }
		this.hist.splice(0, keepFrom);

		await this.Output.write(this.finish(ratePerHour));
	}


	/* Applies `scale`, then `precision`. */
	private finish(meanVal: number): number {
		const scaled = meanVal * this.scale;
		return (this.precision !== null) ? Math.round(scaled / this.precision) * this.precision : scaled;
	}


	/*
	 * Computes the time-weighted mean of Input over the last periodMs, writes it to Output and prunes hist entries that
	 * no later window can need. Called on every input change (event mode) or on a clock tick (clock mode).
	 * Nothing is written for periodMs 0 or an empty hist; event mode also needs two samples. Resolves after the write.
	 */
	private async step(): Promise<void> {
		if (this.rate) {
			await this.stepWindow();
			return;
		}

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
			const end   = clock ? Math.max(lastTs, IoTimer.now()) : lastTs;
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
			const end   = IoTimer.now();
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
