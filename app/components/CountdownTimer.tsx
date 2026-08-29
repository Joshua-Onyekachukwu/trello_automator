'use client';

import { useEffect, useState } from 'react';

interface CountdownTimerProps {
  /** Whether the user has already claimed today */
  hasClaimedToday: boolean;
  /** ISO string of when the user claimed today (if any) */
  claimedAt?: string | null;
  /** Daily limit (0 = unlimited) */
  dailyLimit: number;
  /** Number of cards claimed today */
  claimCount: number;
  /** Whether automation is enabled */
  enabled: boolean;
}

interface TimeLeft {
  hours: number;
  minutes: number;
  seconds: number;
  totalMs: number;
}

function getTimeUntilMidnightLagos(): TimeLeft {
  const now = new Date();

  // Get Lagos midnight (next midnight in Africa/Lagos)
  // Lagos is UTC+1, no DST
  const lagosOffset = 1 * 60 * 60 * 1000; // UTC+1
  const lagosNow = new Date(now.getTime() + lagosOffset);

  // Create midnight in Lagos
  const lagosMidnight = new Date(lagosNow);
  lagosMidnight.setHours(0, 0, 0, 0);
  lagosMidnight.setDate(lagosMidnight.getDate() + 1);

  // Convert back to UTC
  const midnightUtc = new Date(lagosMidnight.getTime() - lagosOffset);

  const totalMs = midnightUtc.getTime() - now.getTime();

  if (totalMs <= 0) {
    return { hours: 0, minutes: 0, seconds: 0, totalMs: 0 };
  }

  const hours = Math.floor(totalMs / (1000 * 60 * 60));
  const minutes = Math.floor((totalMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((totalMs % (1000 * 60)) / 1000);

  return { hours, minutes, seconds, totalMs };
}

function formatTime(time: TimeLeft): string {
  const parts: string[] = [];
  if (time.hours > 0) parts.push(`${time.hours}h`);
  if (time.minutes > 0 || time.hours > 0) parts.push(`${time.minutes}m`);
  parts.push(`${time.seconds}s`);
  return parts.join(' ');
}

function getLagosNowString(): string {
  const now = new Date();
  return now.toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

export default function CountdownTimer({
  hasClaimedToday,
  claimedAt,
  dailyLimit,
  claimCount,
  enabled,
}: CountdownTimerProps) {
  const [timeLeft, setTimeLeft] = useState<TimeLeft | null>(null);
  const [lagosTime, setLagosTime] = useState('');

  useEffect(() => {
    // Initial calculation
    setTimeLeft(getTimeUntilMidnightLagos());
    setLagosTime(getLagosNowString());

    // Update every second
    const interval = setInterval(() => {
      setTimeLeft(getTimeUntilMidnightLagos());
      setLagosTime(getLagosNowString());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const isUnlimited = dailyLimit === 0;
  const canClaimMore = isUnlimited || claimCount < dailyLimit;

  // Determine status message
  let statusMessage = '';
  let statusColor = '#1a7f37';

  if (!enabled) {
    statusMessage = '⏸️ Automation paused';
    statusColor = '#666';
  } else if (hasClaimedToday && !canClaimMore) {
    statusMessage = '🔒 Daily limit reached';
    statusColor = '#c62828';
  } else if (hasClaimedToday && canClaimMore) {
    statusMessage = '✅ Eligible for another card today';
    statusColor = '#1a7f37';
  } else {
    statusMessage = '🟢 Ready to claim';
    statusColor = '#1a7f37';
  }

  return (
    <div style={{
      padding: '16px',
      borderRadius: '8px',
      backgroundColor: '#f8f9fa',
      border: '1px solid #e0e0e0',
      marginTop: '16px',
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '12px',
      }}>
        <div style={{ fontWeight: 600, fontSize: '14px' }}>
          ⏱️ Eligibility Timer
        </div>
        <div style={{
          fontSize: '12px',
          color: '#666',
          fontFamily: 'ui-monospace, monospace',
        }}>
          Lagos: {lagosTime}
        </div>
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        marginBottom: '12px',
      }}>
        <div style={{
          fontSize: '28px',
          fontWeight: 700,
          fontFamily: 'ui-monospace, monospace',
          color: timeLeft && timeLeft.totalMs > 0 ? '#333' : '#1a7f37',
        }}>
          {timeLeft ? formatTime(timeLeft) : '...'}
        </div>
        <div style={{
          fontSize: '13px',
          color: '#666',
          lineHeight: '1.4',
        }}>
          {hasClaimedToday && !canClaimMore ? (
            <>until midnight reset<br />in Africa/Lagos</>
          ) : (
            <>midnight reset<br />in Africa/Lagos</>
          )}
        </div>
      </div>

      <div style={{
        padding: '8px 12px',
        borderRadius: '4px',
        backgroundColor: 'white',
        border: '1px solid #e0e0e0',
        fontSize: '13px',
        color: statusColor,
        fontWeight: 500,
      }}>
        {statusMessage}
      </div>

      {!isUnlimited && claimCount > 0 && (
        <div style={{
          marginTop: '8px',
          fontSize: '12px',
          color: '#666',
        }}>
          Today: {claimCount} / {dailyLimit} cards claimed
        </div>
      )}
    </div>
  );
}
