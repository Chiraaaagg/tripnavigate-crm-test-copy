import type { ReactNode } from 'react';

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-layout">
      <main id="main" className="auth-card" tabIndex={-1}>
        <div className="brand">
          <span className="brand-name">TripNavigate CRM</span>
          <span className="brand-entity">Holiday Chacha Pvt LTD · staff access only</span>
        </div>
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}
