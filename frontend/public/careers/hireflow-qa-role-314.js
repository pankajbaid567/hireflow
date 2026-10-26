/* Public synthetic data only. No forms, cookies, storage, submissions or tracking. */
(async () => {
  const response = await fetch('/careers/hireflow-qa-role-314.json', {credentials: 'omit'});
  if (!response.ok) throw new Error('Synthetic source fixture unavailable');
  const fixture = await response.json();
  const posting = {'@context': 'https://schema.org', '@type': 'JobPosting', ...fixture};
  const node = document.createElement('script');
  node.type = 'application/ld+json'; node.textContent = JSON.stringify(posting); document.head.append(node);
  const container = document.getElementById('job-detail');
  const title = document.createElement('h2'); title.textContent = posting.title;
  const description = document.createElement('p'); description.textContent = posting.description;
  container.replaceChildren(title, description);
})();
