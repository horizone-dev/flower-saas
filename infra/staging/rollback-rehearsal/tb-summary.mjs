// Reads a trial-balance API response on stdin and prints  <Σ closing debit>/<Σ closing credit>/<accounts with movement>  in minor units, using BigInt.
// A balanced ledger prints equal first two numbers. Prints "unreadable" for anything that is not the expected shape.
let s = '';
process.stdin
  .on('data', (d) => (s += d))
  .on('end', () => {
    try {
      const j = JSON.parse(s);
      if (!Array.isArray(j.accounts)) throw new Error('no accounts');
      let d = 0n;
      let c = 0n;
      let moved = 0;
      for (const a of j.accounts) {
        d += BigInt(a.closingDebitMinor);
        c += BigInt(a.closingCreditMinor);
        if (BigInt(a.periodDebitMinor) !== 0n || BigInt(a.periodCreditMinor) !== 0n) moved += 1;
      }
      console.log(`${d}/${c}/${moved}`);
    } catch {
      console.log('unreadable');
    }
  });
