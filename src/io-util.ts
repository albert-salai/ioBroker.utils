import { IoAdapter }		from './io-adapter';
import   nj					from 'numjs';


// sortBy(key)
export function sortBy<T>(key: keyof T): ((a: T, b: T) => number) {
	return (a: T, b: T) => (a[key] > b[key]) ? +1 : ((a[key] < b[key]) ? -1 : 0);
}



/**
 *
 * @param x
 * @param y
 * @returns
 */
export function parabola(x: [ number, number, number ], y: [ number, number, number ]): { a: number, b: number, c: number } {
	// y(x) = a x^2 + b x + c
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





// Magnus
export class Magnus {
	private a	= 17.62;		// see https://library.wmo.int/viewer/68695/download?file=8_I-2023_en.pdf&type=pdf&navigator=1
	private b	= 243.12;		// Guide to Instruments and Methods of Observation - Volume I - Measurement of Meteorological VariablesGuide to Meteorological Instruments and Methods of Observation
	private c	= 6.112;		// ANNEX 4.B. FORMULAE FOR THE COMPUTATION OF MEASURES OF HUMIDITY, page 198, equation 4.B.1

	// sdd(T)
	sdd(T: number): number {						// Sättigungsdampfdruck in hPa
		const { a, b, c } = this;
		return c * Math.exp(a*T / (b + T));			// sdd := c * e^(a*T / (b + T))
	}

	// dd(T, rh)
	dd(T: number, rh: number): number {				// Dampfdruck in hPa
		return rh/100 * this.sdd(T);				// dd := rh/100 * sdd
	}

	// td(T, rh)
	td(T: number, rh: number): number {				// TD = Taupunkttemperatur in °C
		const { a, b, c } = this;
		const sdd = this.dd(T, rh);					// sdd := dd
		const v = Math.log(sdd / c);				// v   := ln(sdd / c);
		return b*v / (a - v);						// T    = b*v / (a - v)
	}
}



// ~~~
// IIR
// ~~~
export class IIR {
	public	b:	number[];
	public	a:	number[];
	private	w:	(number | null)[];

	/**
	 *
	 * @param opts
	 */
	constructor(opts: { b: number[], a: number[] }) {
		//IoAdapter.logf.debug('%-15s %-15s %-10s:\n%s', this.constructor.name, 'constructor()', 'opts', JSON.stringify(opts, null, 4));
		if (Array.isArray(opts.b)  &&  Array.isArray(opts.a)  &&  opts.b.length === opts.a.length  &&  opts.a.length > 0  &&  opts.a[0] !== undefined) {
			const a0 = opts.a[0];
			this.b	 = opts.b.map((b) => b/a0);
			this.a	 = opts.a.map((a) => a/a0);						// a[0] := 1
			this.w	 = Array<null>(this.a.length).fill(null);		// w[i] := null
			//IoAdapter.this.IoAdapter.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'constructor()', 'b', JSON.stringify(this.b, null, 4));
			//IoAdapter.this.IoAdapter.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'constructor()', 'a', JSON.stringify(this.a, null, 4));

		} else {
			throw new Error(`${this.constructor.name}: constructor(): invalid config ${JSON.stringify(opts)}`);
		}
	}


	/**
	 *
	 * @param x_0
	 * @returns
	 */
	next(x_0: number): number {
		// init
		if (this.w[0] === null) {
			const a_sum = this.a.reduce((sum, a_i) => (sum + a_i), 0);
			this.w.fill(x_0 / a_sum);
		}

		// insert w[0] := x[0] - [ a[1]*w[1] + a[2]*w[2] + ... ]
		this.w.unshift(0);
		this.w[0]  = this.a.reduce((acc, a_i, i) => (acc - a_i*(this.w[i] ?? 0)), x_0);
		this.w.pop();			// remove last w

		// y[0] := b[0]*w[0] + b[1]*w[1] + b[2]*w[2]
		const  y_0 = this.b.reduce((acc, b_i, i) => (acc + b_i*(this.w[i] ?? 0)), 0);
		return y_0;
	}
}



/**
 *
 * @param f
 * @param x0
 * @param options
 * @returns
 */
// see	https://github.com/scijs/newton-raphson-method#readme
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
	// options
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
		// compute the value of the function
		const y = f(x0);

		// yp: derivative at x0
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

		// check for badly conditioned update (extremely small first deriv relative to function):
		if (Math.abs(yp) <= epsilon * Math.abs(y)) {
			IoAdapter.logf.error('Newton-Raphson: failed to converged due to nearly zero first derivative');
			return false;
		}

		// update the guess
		const x1 = Math.max(xMin, Math.min(xMax, x0 - y/yp));		// xMin <= x1 <= xMax

		// Check for convergence:
		if (Math.abs(x1 - x0) <= tolerance * Math.abs(x1)) {
			if (verbose) {
				IoAdapter.logf.debug('Newton-Raphson: converged to x = ' + String(x1) + ' after ' + String(iter) + ' iterations');
			}
			return x1;
		}

		// transfer update to the new guess
		x0 = x1;
	}

	IoAdapter.logf.warn('Newton-Raphson: Maximum iterations reached (' + String(maxIter) + ')');
	return false;
}



/**
 *
 */
export class RLS {
	private dimensions				= 1;									// Number of features
	private lambda					= 0.95;									// Forgetting			factor
	private eye:		nj.NdArray	= nj.identity(this.dimensions);			// Identity				matrix
	private w_hat:		nj.NdArray	= nj.zeros(this.dimensions);			// Estimated Parameters	vector
	private P:			nj.NdArray	= this.eye.multiply(1);					// Covariance			matrix

	/**
	 *
	 * @param w
	 * @param delta
	 * @param lambda
	 */
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

	// Update the model with new data
	public update(x_vals: number[], y_val: number): number[] {
		// https://en.wikipedia.org/wiki/Recursive_least_squares_filter
		const x		= nj.array(x_vals).reshape(this.dimensions, 1);		// input column vector
		const xT	= x.T;												// input row    vector

		// get y_err
		const y_hat:	number		= xT.dot(this.w_hat).get(0, 0);
		const y_err:	number		= y_val - y_hat;

		// get Kalman gain column vector g := P x / (lambda + xT P x)
		const xT_P:		nj.NdArray	= xT.dot(this.P);										// row    vector
		const x_xT_P:	nj.NdArray	= x.dot(xT_P);											// matrix
		const xT_P_x:	number		= xT_P.dot(x).get(0, 0);								// number
		const P_x:		nj.NdArray	= this.P.dot(x);										// column vector
		const gain:		nj.NdArray	= P_x.multiply(1/(this.lambda + xT_P_x));				// column vector

		// update Covariance Matrix		P <-- 1/lambda (P - (P x xT P)/(lambda + xT P x))
		//								P <-- P (I - (x xT P)/(lambda + xT P x)) 1/lambda
		this.P = this.P.dot(this.eye.subtract(x_xT_P)).multiply(1/(this.lambda + xT_P_x));

		// update Parameter estimate w_hat += y_err gain
		this.w_hat.add(gain.multiply(y_err), false);

		/*
		IoAdapter.this.IoAdapter.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'P',		JSON.stringify(this.P		));
		IoAdapter.this.IoAdapter.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'x', 		JSON.stringify(x			));
		IoAdapter.this.IoAdapter.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'xT',		JSON.stringify(xT			));
		IoAdapter.this.IoAdapter.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'y_hat',	JSON.stringify(y_hat		));
		IoAdapter.this.IoAdapter.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'y_err',	JSON.stringify(y_err		));
		IoAdapter.this.IoAdapter.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'P_x',		JSON.stringify(P_x			));
		IoAdapter.this.IoAdapter.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'xT_P_x',	JSON.stringify(xT_P_x		));
		IoAdapter.this.IoAdapter.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'gain',		JSON.stringify(gain			));
		IoAdapter.this.IoAdapter.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'update()', 'w_hat',	JSON.stringify(this.w_hat	));
		*/
		return this.w_hat.reshape(this.dimensions).tolist();
	}
}
