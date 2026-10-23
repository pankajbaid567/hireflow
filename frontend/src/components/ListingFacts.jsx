function payText(value) {
  if (!value?.disclosed) return 'Not disclosed';
  if (value.source === 'explicit_unpaid') return 'Unpaid';
  const number = amount => typeof amount === 'number' ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(amount) : 'Not stated';
  const range = value.minimum === value.maximum ? number(value.minimum) : `${number(value.minimum)}–${number(value.maximum)}`;
  return `${value.currency || 'Currency unspecified'} ${range} / ${value.period || 'period unspecified'}`;
}
const dateText = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString() : 'Not stated';
export default function ListingFacts({ job }) {
  const experience = job.required_experience;
  const method = job.matching_method === 'hybrid' ? 'Hybrid skill matching' : 'Keyword skill matching';
  return <details className="listing-facts"><summary>Listing details and matching</summary><dl>
    <div><dt>Pay</dt><dd>{payText(job.compensation)}</dd></div>
    <div><dt>Required experience</dt><dd>{experience ? `${experience.minimum_years}${experience.maximum_years == null ? '+' : `–${experience.maximum_years}`} years` : 'Not stated'}</dd></div>
    <div><dt>Posted</dt><dd>{dateText(job.posted_date)}</dd></div><div><dt>Expires</dt><dd>{dateText(job.expires_at)}</dd></div>
    <div><dt>Matching</dt><dd>{method}{job.matching_method === 'lexical' && job.matching_state === 'budget_limited' ? ' · daily semantic allowance reached' : job.matching_method === 'lexical' && job.matching_state === 'unavailable' ? ' · semantic service unavailable' : ''}</dd></div>
  </dl><p className="field-help">Match scores compare your stated facts with this listing; they are not hiring probabilities. Currency conversion is not assumed.</p>
    {Array.isArray(job.selection_process) && job.selection_process.length > 0 && <><strong>Selection process stated in the listing</strong><ul>{job.selection_process.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
    {job.quality?.reason && <p className="field-help">Listing check: {job.quality.reason}</p>}
  </details>;
}
