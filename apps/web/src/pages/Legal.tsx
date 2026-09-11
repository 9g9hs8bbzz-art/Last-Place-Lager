import { useEffect, useState } from 'react';
import { Card } from '../components/ui';

export function Legal() {
  const [legal, setLegal] = useState<Record<string, string> | null>(null);
  useEffect(() => { fetch('/api/legal').then((r) => r.json()).then(setLegal).catch(() => {}); }, []);
  if (!legal) return null;
  return (
    <>
      <Card title="Adults only">{legal.adultsOnly}</Card>
      <Card title="This is not a sportsbook">{legal.notASportsbook}</Card>
      <Card title="Responsible gambling">{legal.responsibleGambling}</Card>
      <Card title="Privacy">{legal.privacy}</Card>
    </>
  );
}
