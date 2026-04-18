import { IoState }		from '../io-state';
import { IoOperator }	from '../io-operator';
import { IoTimer }		from '../io-timer';
import type { AnyState }	from '../io-state';


type MovingAvgWinType = "rect" | "hann" | "hamming" | "blackman" | "nuttall";

/* Streaming causal windowed integration smoother for irregular ZOH step signal.
   - Input is a left-continuous zero-order hold (ZOH) step signal:
       x(t) = x[i] for t in [t[i-1], t[i])
   - Output is produced on a regular time grid with spacing delta.
   - Smoothing is performed by weighted integration over a finite window of length T.
   - Causality is enforced via a constant delay D = T/2, so each output at t_out uses data only from [t_out - T, t_out].
   - Missing future data is handled by truncating the integration window to available samples and renormalizing (no extrapolation).
   - Supported window functions: rectangular, hann, hamming, blackman, nuttall.
*/
export class OpMovingAvg extends IoOperator {
	private static readonly PI2			= 2 * Math.PI;
	private static readonly PI2_INV1	= 1 / (    OpMovingAvg.PI2);
	private static readonly PI2_INV2	= 1 / (2 * OpMovingAvg.PI2);
	private static readonly PI2_INV3	= 1 / (3 * OpMovingAvg.PI2);

	private readonly Input:			IoState<number>;			// irregular step input (timestamps in ms)
	private readonly Output:		IoState<number>;			// smoothed output on regular grid

	private readonly winType:		MovingAvgWinType;
	private readonly winIntegral:	(x: number) => number;		// window integral function (normalized to winIntegral(1) = 1 for the full window)
	private readonly winArea:		number;						// area under the window function (for normalization when truncating the window)
	private readonly winMs:			number;						// window length in ms
	private readonly clockMs:		number;						// output cadence in ms; <= 0 means event-driven

	// sample log (timestamps in ms as received from Input)
	private readonly samples: { ts: number; val: number }[] = [];

	constructor({ Input, Output, periodSecs, clockSecs, windowType }: {
		Input:			IoState<number>;
		Output:			IoState<number>;
		periodSecs:		number;
		clockSecs:		number;
		windowType:		MovingAvgWinType;
	}) {
		super([Input], [Output], []);
		this.Input	= Input;
		this.Output	= Output;
		this.clockMs		= (clockSecs <= 0) ? 0 : Math.round(1000 * clockSecs);
		this.winMs			= Math.round(Math.max(0, 1000 * periodSecs));		// ensure non-negative
		this.winType		= windowType;
		this.winIntegral	= OpMovingAvg.MAKE_WIN_INTEGRAL(this.winType);
		this.winArea 		= OpMovingAvg.WIN_INTEGRAL_AREA[this.winType];
	}

	/* Seeds the sample buffer from stored history and starts the clock timer if `clockMs` > 0. */
	protected override async setup(): Promise<boolean> {
		const end	= this.Input.ts;
		const start	= end - this.winMs;
		const history = await this.Input.getHistory({ start, end, limit: 10000 });

		if (history.length === 0) {
			// no history: create artificial anchor at t=0
			this.samples.push({ ts: 0, val: this.Input.val });
		} else {
			let oldest: { ts: number; val: number } | undefined;
			for (const { ts, val } of history) {
				const entry = { ts, val };
				oldest ??= entry;
				this.samples.push(entry);
			}
			// anchor earliest sample at t=0 to ensure full window coverage
			if (oldest) oldest.ts = 0;
		}

		if (this.clockMs > 0) {
			// align periodic execution to wall clock boundaries
			const tzOffsetMs = new Date().getTimezoneOffset() * 60000;
			const intervalMs = this.clockMs;
			const timeoutMs = intervalMs - ((IoTimer.now() - tzOffsetMs) % intervalMs);

			IoTimer.setTimer({
				name: this.constructor.name,
				timeoutMs,
				intervalMs,
				cb: async () => {
					await this.step();
				}
			});
		}

		return true;
	}

	/* Appends the new input sample and triggers processing in event mode. */
	protected override async execute(_trigger: AnyState): Promise<void> {
		this.samples.push({
			ts:		this.Input.ts,
			val:	this.Input.val
		});

		if (this.clockMs <= 0) {
			await this.step();
		}
	}

	// FIXME: Normalize windows:
	// this.winIntegral(0) shall always be 0
	// this.winIntegral(1) shall always be 1

	/* Computes the weighted-window mean over [now − winMs, now] and writes it to Output.
	   Prunes samples entirely before the window after each call.
	   No-op if fewer than two samples are available.
	*/
	private async step(): Promise<void> {
		// integration window bounds before truncation [wBegin, wEnd]
		const wEnd   	= IoTimer.now();				// current output time
		const wBegin 	= wEnd - this.winMs;		// window start time

		const last = this.samples[this.samples.length - 1];
		if (! last)						return;		// skip this step if there are no samples at all (shouldn't happen since setup() seeds one)
		if (last.ts <= wBegin)			return;		// skip this step if the latest sample is still too old to contribute to the window
		if (this.samples.length < 2)	return;		// skip this step if there is only one sample (no segments to integrate)

		// integral numerator (weighted integral)
		let num = 0;

		// -------------------------
		// Step 1: main ZOH segments
		// -------------------------
		for (let i = 1; i < this.samples.length; i++) {
			const s_a = this.samples[i - 1];
			const s_b = this.samples[i    ];
			if (! s_a || ! s_b ) continue;			// i is within bounds; guard satisfies strict index checks
			if (s_b.ts < wBegin) continue;			// skip segment if it ends before the window
			if (s_a.ts > wEnd  ) break;				// stop if segment starts after the window

			const t0 = Math.max(s_a.ts, wBegin);	// clamp segment start to window
			const t1 = Math.min(s_b.ts, wEnd  );	// clamp segment end   to window

			const w0 = (t0 - wBegin) / this.winMs;
			const w1 = (t1 - wBegin) / this.winMs;
			num += (this.winIntegral(w1) - this.winIntegral(w0)) * s_b.val;
		}

		// -------------------------
		// Step 2: write output
		// -------------------------
		if (last.ts < wEnd) {
			// num corresponds to the integral up to last.ts; don't integrate the remaining segment from last.ts to wEnd
			const w1 = (last.ts - wBegin) / this.winMs;
			await this.Output.write(num / this.winIntegral(w1));

		} else {
			await this.Output.write(num / this.winArea);
		}

		// -------------------------
		// Step 3: prune old samples, keep one carry for next step
		// -------------------------
		while (this.samples.length > 1) {
			const second = this.samples[1];
			if (! second) break;
			if (second.ts < wBegin) this.samples.shift();
			else break;
		}
	}


	/* Returns the cumulative integral function for the given window type, normalised so that the result at x=1 equals WIN_INTEGRAL_AREA[windowType]. */
	private static MAKE_WIN_INTEGRAL(windowType: MovingAvgWinType): (x: number) => number {
		return OpMovingAvg.WIN_INTEGRAL_FN[windowType];
	}

	private static readonly WIN_INTEGRAL_AREA: Record<MovingAvgWinType, number> = {	// exact areas: winIntegral(1)
		hann:			0.5,
		hamming:		0.54,
		blackman:		0.42,
		nuttall:		0.355768,
		rect:			1
	};

	private static readonly WIN_INTEGRAL_FN: Record<MovingAvgWinType, (x: number) => number> = {	// prebuilt integral functions (created at class initialisation)
		hann: (x: number) => {
			if (x <= 0) return 0;
			if (x >= 1) return OpMovingAvg.WIN_INTEGRAL_AREA.hann;

			const a  = OpMovingAvg.PI2 * x;
			const s1 = Math.sin(a);

			return OpMovingAvg.WIN_INTEGRAL_AREA.hann * (x - s1 * OpMovingAvg.PI2_INV1);
		},

		hamming: (x: number) => {
			if (x <= 0) return 0;
			if (x >= 1) return OpMovingAvg.WIN_INTEGRAL_AREA.hamming;

			const a  = OpMovingAvg.PI2 * x;
			const s1 = Math.sin(a);

			return OpMovingAvg.WIN_INTEGRAL_AREA.hamming * (x - s1 * OpMovingAvg.PI2_INV1);
		},

		blackman: (x: number) => {
			if (x <= 0) return 0;
			if (x >= 1) return OpMovingAvg.WIN_INTEGRAL_AREA.blackman;

			const a  = OpMovingAvg.PI2 * x;
			const s1 = Math.sin(a);
			const c1 = Math.cos(a);

			// sin(2a) = 2 sin(a) cos(a)
			const s2 = 2 * s1 * c1;

			return OpMovingAvg.WIN_INTEGRAL_AREA.blackman * x
				- 0.5  * s1 * OpMovingAvg.PI2_INV1
				+ 0.08 * s2 * OpMovingAvg.PI2_INV2;
		},

		nuttall: (x: number) => {
			if (x <= 0) return 0;
			if (x >= 1) return OpMovingAvg.WIN_INTEGRAL_AREA.nuttall;

			const a  = OpMovingAvg.PI2 * x;
			const s1 = Math.sin(a);
			const c1 = Math.cos(a);

			// recurrences
			const s2 = 2*s1*c1;             	// sin(2a)
			const s3 = 3*s1 - 4*s1*s1*s1;		// sin(3a)

			return (
				OpMovingAvg.WIN_INTEGRAL_AREA.nuttall * x
				- 0.487396 * s1 * OpMovingAvg.PI2_INV1
				+ 0.144232 * s2 * OpMovingAvg.PI2_INV2
				- 0.012604 * s3 * OpMovingAvg.PI2_INV3
			);
		},

		rect: (x: number) => {
			return x <= 0 ? 0 : x >= 1 ? 1 : x;
		}
	};
}
