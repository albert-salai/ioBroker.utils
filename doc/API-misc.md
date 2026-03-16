# Utilities — `/opt/iobroker/my_modules/ioBroker.utils/src/io-util.ts`

```ts
// Comparator factory for Array.sort()
sortBy<T>(key: keyof T): (a: T, b: T) => number

// Fit parabola y = ax²+bx+c through 3 points
parabola(x: [n,n,n], y: [n,n,n]): { a, b, c }

// Magnus humidity formulas (WMO-No.8, water, –45°C to 60°C)
class Magnus {
  sdd(T): number    // saturation vapour pressure [hPa]
  dd(T, rh): number // actual vapour pressure [hPa]
  td(T, rh): number // dew point [°C]
}

// IIR digital filter (Direct Form II Transposed)
class IIR {
  constructor(opts: { b: number[], a: number[] })  // b/a normalized by a[0]
  next(x: number): number                          // feed sample, get filtered output; auto-initializes on first call
}

// Newton-Raphson root finder
newtonRaphson(f, x0, opts?: { fp?, h?, tolerance?, epsilon?, maxIter?, xMin?, xMax?, verbose? }): number | false

// Recursive Least Squares adaptive filter
class RLS {
  init(w: number[], lambda: number, P: number | number[][]): void
    // w: initial weights, lambda: forgetting factor (0<λ≤1), P: initial covariance (scalar → λI)
  update(x_vals: number[], y_val: number): number[]  // returns updated weight vector
}
```

---
*Last updated: 2026-03-15*
