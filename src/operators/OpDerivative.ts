import { IoState }		from '../io-state';
import { IoOperator }	from '../io-operator';
import type { AnyState }	from '../io-state';


/*
 * Computes the time derivative of a numeric input as the difference quotient between its last two changes,
 * `(curr.val - prev.val) / (curr.ts - prev.ts)` per `perSecs`, and writes it to an output with every input change.
 * The input is taken as linear between two changes, so the output is its exact slope there; the mean of the output
 * over any window (OpMean) equals the input difference over that window divided by its length.
 *
 * The output describes the interval prev.ts → curr.ts and is written at now (no backdating), so it follows the
 * backward timestamp convention: valid from the previous sample's timestamp up to its own timestamp. Feed a downstream
 * OpMean with `backward: true`; with `precision` here also with `triggerOnUnchanged: true`, as an output can then repeat
 * and a backward mean would otherwise stretch the next value over the skipped interval. If the output logs to SQL, set
 * `changesOnly: false` on it, or the mean's start-up reads a history without the repeated values.
 *
 * An optional `scale` multiplies the derivative (default 1.0), then an optional `precision` snaps the result before
 * writing.
 * `precision` is a snap step, not a number of decimals: the output is `Math.round(value * scale / precision) *
 * precision` (1: whole numbers, 0.1: one decimal, 0.25: quarters, 5: multiples of 5); unset: no rounding. 0 is invalid
 * (division by zero). A step such as 0.1 can leave float noise (0.30000000000000004); whole numbers and 0.25 are exact.
 * Too coarse a step loses information (a slow discharge curve turns into plateaus).
 * Nothing is written for the first sample or for time that does not advance.
 * For a counter (e.g. kWh -> kW with `perSecs: 3600`) a reset writes one negative slope; a read glitch (drop and
 * return) writes two slopes that cancel in a downstream mean.
 */
export class OpDerivative extends IoOperator {
	private readonly	Input:			IoState<number>;
	private readonly	Output:			IoState<number>;
	private readonly	perMs:			number;										// time unit of the output [ms]; > 0
	private readonly	precision:		number | null;								// output snap increment; null = disabled
	private readonly	scale:			number;										// output factor, applied before precision
	private				prev:			{ val: number, ts: number } | undefined;	// previous input sample

	/*
	 * `perSecs`: time unit of the output in seconds (default 1: per second; 3600: per hour).
	 * `precision`: if set, output is rounded to the nearest multiple of this value.
	 * `scale`: output factor, default 1.0.
	 */
	constructor({ Input, Output, perSecs, precision, scale }: {
		Input:				IoState<number>,
		Output:				IoState<number>,
		perSecs?:			number,
		precision?:			number,
		scale?:				number,
	}) {
		super([ Input ], [ Output ], []);

		this.Input			= Input;
		this.Output			= Output;

		this.perMs			= Math.round(1000*(perSecs ?? 1));		// [ms/unit]
		this.scale			= scale ?? 1;
		this.precision		= precision ?? null;
	}

	/* Seeds prev from the newest input sample before the current value. */
	protected override async setup(): Promise<boolean> {
		// no start: sql.0 then returns the newest row up to end
		const rows	= await this.Input.getHistory({ end: this.Input.ts - 1, limit: 1 });
		this.prev	= rows.at(-1);
		return true;
	}


	/*
	 * Writes the slope between the previous and the current input sample. Nothing is written for the first sample,
	 * an unchanged value (seeded prev only: an unchanged state does not trigger) or time that does not advance.
	 * Resolves after the write.
	 */
	protected override async execute(_trigger: AnyState): Promise<void> {
		const prev = this.prev;
		if (this.Input.val === prev?.val) { return; }

		const curr	= { val: this.Input.val, ts: this.Input.ts };
		this.prev	= curr;
		if (!prev || curr.ts <= prev.ts) { return; }

		const slope = (curr.val - prev.val) * this.perMs / (curr.ts - prev.ts);
		await this.Output.write(this.finish(slope));
	}


	/* Applies `scale`, then `precision`. */
	private finish(slope: number): number {
		const scaled = slope * this.scale;
		return (this.precision !== null) ? Math.round(scaled / this.precision) * this.precision : scaled;
	}
}
