import { IoAdapter }		from './io-adapter';
import   nj					from 'numjs';


export function sortBy<T>(key: keyof T): ((a: T, b: T) => number) {
	return (a: T, b: T) => (a[key] > b[key]) ? 1 : ((a[key] < b[key]) ? -1 : 0);
}


/** Fits a parabola y(x) = ax² + bx + c through three points. */
export function parabola(x: [ number, number, number ], y: [ number, number, number ]): { a: number, b: number, c: number } {
	const xx0 = x[0] * x[0];
	const xx1 = x[1] * x[1];
	const xx2 = x[2] * x[2];
	const y10 = y[1] - y[0];
	const y20 = y[2] - y[0];
	const y21 = y[2] - y[1];
	const x10 = x[1] - x[0];
	const x20 = x[2] - x[0];
	const x21 = x[2] - x[1];
	const den = x10 * x20 * x21;
	return {
		'a':	(-x[0]*y21 + x[1]*y20 - x[2]*y10)													/ den,
		'b':	( xx0 *y21 - xx1 *y20 + xx2 *y10) 													/ den,
		'c':	(-xx0 *(x[1]*y[2] - x[2]*y[1]) - x[0] * (xx2*y[1] - xx1*y[2]) + x[1]*x[2]*x21*y[0])	/ den
	};
}


// Magnus formula for saturation vapor pressure — constants from WMO-No. 8 Annex 4.B, p.119, Water (–45°C to 60°C)
// see https://www.weather.gov/media/epz/mesonet/CWOP-WMO8.pdf
export class Magnus {
	private a	= 17.62;
	private b	= 243.12;
	private c	= 6.112;

	sdd(T: number): number {						// Sättigungsdampfdruck in hPa
		const { a, b, c } = this;
		return c * Math.exp(a*T / (b + T));
	}

	dd(T: number, rh: number): number {				// Dampfdruck in hPa
		return rh/100 * this.sdd(T);
	}

	td(T: number, rh: number): number {				// Taupunkttemperatur in °C
		const { a, b } = this;
		const v = a*T / (b + T) + Math.log(rh/100);
		return    b*v / (a - v);
	}
}



// Direct-form II transposed IIR filter. Coefficients are normalized to a[0] on construction.
export class IIR {
	public	b:	number[];
	public	a:	number[];
	private	w:	(number | null)[];

	constructor(opts: { b: number[], a: number[] }) {
		if (Array.isArray(opts.b)  &&  Array.isArray(opts.a)  &&  opts.b.length === opts.a.length  &&  opts.a.length > 0  &&  opts.a[0] !== undefined) {
			const a0 = opts.a[0];
			this.b	 = opts.b.map((b) => b/a0);
			this.a	 = opts.a.map((a) => a/a0);		// normalize so a[0] = 1
			this.w	 = Array<null>(this.a.length).fill(null);
		} else {
			throw new Error(`${this.constructor.name}: constructor(): invalid config ${JSON.stringify(opts)}`);
		}
	}


	next(x_0: number): number {
		// lazy init: pre-fill state so the filter starts at steady-state for x_0
		if (this.w[0] === null) {
			const a_sum = this.a.reduce((sum, a_i) => (sum + a_i), 0);
			this.w.fill(x_0 / a_sum);
		}

		// insert w[0] := x[0] - [ a[1]*w[1] + a[2]*w[2] + ... ]
		this.w.unshift(0);
		this.w[0]  = this.a.reduce((acc, a_i, i) => (acc - a_i*(this.w[i] ?? 0)), x_0);
		this.w.pop();

		// y[0] := b[0]*w[0] + b[1]*w[1] + b[2]*w[2]
		const  y_0 = this.b.reduce((acc, b_i, i) => (acc + b_i*(this.w[i] ?? 0)), 0);
		return y_0;
	}
}



// see https://github.com/scijs/newton-raphson-method#readme
// When fp is omitted, the derivative is estimated via a 5-point stencil (O(h^4) accuracy).
// xMin/xMax are expanded inward by 2h+tolerance when fp is absent to keep finite-difference points in bounds.
// Returns false if the derivative becomes nearly zero (ill-conditioned) or maxIter is reached.
export function newtonRaphson(f: (x: number) => number, x0: number, options: {
	fp?:			(x: number) => number,
	h?:				number,
	tolerance?:		number,
	epsilon?:		number,
	maxIter?:		number,
	xMin?:			number,
	xMax?:			number,
	verbose?:		boolean,
}): number | false {
	const tolerance		= (options.tolerance	?? 1e-9				);
	const epsilon		= (options.epsilon		?? 1e-16			);
	const maxIter		= (options.maxIter		?? 20				);
	const h				= (options.h			?? 1e-4				);
	const verbose		= (options.verbose		?? false			);
	const xMin			= (options.xMin			?? Number.MIN_VALUE	) + (options.fp ? 0 : (2*h + tolerance));
	const xMax			= (options.xMax			?? Number.MAX_VALUE	) - (options.fp ? 0 : (2*h + tolerance));

	const hr = 1 / h;
	let iter = 0;
	while (iter++ < maxIter) {
		const y = f(x0);

		// derivative: use analytic fp if provided, else 5-point finite difference
		let yp: number;
		if (options.fp) {
			yp = options.fp(x0);
		} else {
			const yph  = f(x0 +   h);
			const ymh  = f(x0 -   h);
			const yp2h = f(x0 + 2*h);
			const ym2h = f(x0 - 2*h);
			yp = ((ym2h - yp2h) + 8*(yph - ymh)) * hr / 12;
		}

		// abort if first derivative is negligible relative to function value
		if (Math.abs(yp) <= epsilon * Math.abs(y)) {
			IoAdapter.logf.error('Newton-Raphson: failed to converge due to nearly zero first derivative');
			return false;
		}

		const x1 = Math.max(xMin, Math.min(xMax, x0 - y/yp));		// xMin <= x1 <= xMax

		if (Math.abs(x1 - x0) <= tolerance * Math.abs(x1)) {
			if (verbose) {
				IoAdapter.logf.debug('Newton-Raphson: converged to x = ' + String(x1) + ' after ' + String(iter) + ' iterations');
			}
			return x1;
		}

		x0 = x1;
	}

	IoAdapter.logf.warn('Newton-Raphson: Maximum iterations reached (' + String(maxIter) + ')');
	return false;
}



// Recursive Least Squares filter with forgetting factor.
// Caller must call init() before the first update(); default field values are placeholders only.
// see https://en.wikipedia.org/wiki/Recursive_least_squares_filter
export class RLS {
	private dimensions				= 1;
	private lambda					= 0.95;
	private eye:		nj.NdArray	= nj.identity(this.dimensions);
	private w_hat:		nj.NdArray	= nj.zeros(this.dimensions);
	private P:			nj.NdArray	= this.eye.multiply(1);

	public init(w: number[], lambda: number, P: number|number[][]): void {
		this.dimensions	= w.length;
		this.lambda		= lambda;
		this.eye		= nj.identity(this.dimensions);
		this.w_hat		= nj.array(w).reshape(this.dimensions, 1);			// parameter estimate column vector
		IoAdapter.logf.debug('%-15s %-15s %-10s %s', this.constructor.name, 'init()', 'eye',	JSON.stringify(this.eye		));
		IoAdapter.logf.debug('%-15s %-15s %-10s %s', this.constructor.name, 'init()', 'w_hat',	JSON.stringify(this.w_hat	));

		if (typeof P === 'number') {
			this.P = this.eye.multiply(P);
		} else if (P[0]) {
			this.P = nj.array(P.flat()).reshape(P.length, P[0].length);
		}
		IoAdapter.logf.debug('%-15s %-15s %-10s %s', this.constructor.name, 'init()', 'P',		JSON.stringify(this.P		));
	}

	public update(x_vals: number[], y_val: number): number[] {
		const x		= nj.array(x_vals).reshape(this.dimensions, 1);		// input column vector
		const xT	= x.T;												// input row    vector

		const y_hat:	number		= xT.dot(this.w_hat).get(0, 0);
		const y_err:	number		= y_val - y_hat;

		// Kalman gain: g := P x / (lambda + xT P x)
		const xT_P:		nj.NdArray	= xT.dot(this.P);										// row    vector
		const x_xT_P:	nj.NdArray	= x.dot(xT_P);											// matrix
		const xT_P_x:	number		= xT_P.dot(x).get(0, 0);								// number
		const P_x:		nj.NdArray	= this.P.dot(x);										// column vector
		const gain:		nj.NdArray	= P_x.multiply(1/(this.lambda + xT_P_x));				// column vector

		// P <-- 1/lambda (P - (P x xT P)/(lambda + xT P x))
		//     = P (I - (x xT P)/(lambda + xT P x)) 1/lambda
		this.P = this.P.dot(this.eye.subtract(x_xT_P)).multiply(1/(this.lambda + xT_P_x));

		// w_hat += y_err * gain  (mutates w_hat in-place via numjs add with false flag)
		this.w_hat.add(gain.multiply(y_err), false);

		/*
		IoAdapter.this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'P',		JSON.stringify(this.P		));
		IoAdapter.this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'x', 		JSON.stringify(x			));
		IoAdapter.this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'xT',		JSON.stringify(xT			));
		IoAdapter.this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'y_hat',	JSON.stringify(y_hat		));
		IoAdapter.this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'y_err',	JSON.stringify(y_err		));
		IoAdapter.this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'P_x',		JSON.stringify(P_x			));
		IoAdapter.this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'xT_P_x',	JSON.stringify(xT_P_x		));
		IoAdapter.this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'gain',		JSON.stringify(gain			));
		IoAdapter.this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'w_hat',	JSON.stringify(this.w_hat	));
		*/
		return this.w_hat.reshape(this.dimensions).tolist();
	}
}

