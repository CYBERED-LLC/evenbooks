/**
 * How to get your history out of Wave. The import hub and the wizard show the same steps;
 * both of Wave's exports are read as is (the General Ledger report is unfolded per account).
 */
export function WaveExportSteps({ className }: { className?: string }) {
  return (
    <div className={className}>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-stone-600" aria-label="Export from Wave">
        <li>In Wave, open Reports → Account Transactions (General Ledger).</li>
        <li>Set the dates to cover everything, from the day you started with Wave until today, and keep All accounts selected.</li>
        <li>Choose Export → CSV and upload that file here, unchanged.</li>
      </ol>
      <p className="mt-2 text-sm text-stone-600">
        Wave&rsquo;s other export works too: Settings → Data export → Export accounting transactions.
      </p>
    </div>
  );
}
