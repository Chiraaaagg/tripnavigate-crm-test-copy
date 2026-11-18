import { AuthCard } from '@/components/AuthCard';
import { SubmitButton } from '@/components/SubmitButton';
import { finishOnboardingAction } from '@/modules/identity/server/actions';

export function FinishOnboardingView() {
  return (
    <AuthCard title="Authenticator set up">
      <div className="message success" role="status">
        Your authenticator is working. Keep your phone secure; you will need it at every sign-in.
      </div>
      <p>Finish setup to activate the branch and role your administrator assigned.</p>
      <form action={finishOnboardingAction}>
        <SubmitButton pendingLabel="Activating…">Finish setup</SubmitButton>
      </form>
    </AuthCard>
  );
}
