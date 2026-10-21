export default function TopicBadge({ topic, level = 'strong' }) {
  const text = typeof topic === 'string' ? topic : topic?.name || topic?.topic || topic?.skill || '';
  return <span className={`topic-badge topic-${level}`}>{text}</span>;
}
