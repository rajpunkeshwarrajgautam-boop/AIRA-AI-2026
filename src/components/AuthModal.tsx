import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Lock,
  Mail,
  User,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Loader2,
  LogOut,
  KeyRound,
  Eye,
  EyeOff,
  Database,
  ArrowRight,
  ExternalLink
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { neonAuth, NeonUser, NeonSessionData } from '../lib/neonAuth';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthSuccess?: (user: NeonUser) => void;
}

type AuthTab = 'signin' | 'signup' | 'recovery' | 'profile';

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose, onAuthSuccess }) => {
  const [activeTab, setActiveTab] = useState<AuthTab>('signin');
  const [currentUser, setCurrentUser] = useState<NeonUser | null>(() => neonAuth.getCurrentUser());
  const [_currentSession, setCurrentSession] = useState<NeonSessionData | null>(() => neonAuth.getCurrentSession());

  // Form states
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryToken, setRecoveryToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [preserveGuestData, setPreserveGuestData] = useState(true);
  const [showPassword, setShowPassword] = useState(false);

  // Direct OAuth provider linking & recovery states
  const [linkedProviders, setLinkedProviders] = useState<Array<{ provider: 'google' | 'github'; email?: string; linkedAt: number }>>([]);
  const [recoveryContact, setRecoveryContact] = useState('');
  const [recoveryDetails, setRecoveryDetails] = useState('');

  // Status & Feedback states
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [serverVerification, setServerVerification] = useState<{
    status: string;
    userId: string;
    provider: string;
    email?: string;
  } | null>(null);

  const initialFocusRef = useRef<HTMLInputElement>(null);

  const fetchLinkedProviders = async () => {
    try {
      const res = await fetch('/api/auth/providers', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setLinkedProviders(data.providers || []);
      }
    } catch {
      // offline / mock fallback
    }
  };

  useEffect(() => {
    const unsubscribe = neonAuth.onAuthStateChange((user, session) => {
      setCurrentUser(user);
      setCurrentSession(session);
      if (user) {
        setActiveTab('profile');
        fetchLinkedProviders();
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (currentUser && isOpen) {
      fetchLinkedProviders();
    }
  }, [currentUser, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      setErrorMessage(null);
      setSuccessMessage(null);
      setServerVerification(null);
      if (currentUser) {
        setActiveTab('profile');
      } else {
        setActiveTab('signin');
      }
      initialFocusRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [isOpen, currentUser]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsLoading(true);

    try {
      if (!email.trim() || !password) {
        throw new Error('Please provide both email and password');
      }
      const { user } = await neonAuth.signIn({
        email: email.trim(),
        password,
        preserveGuestData
      });
      setSuccessMessage(`Welcome back, ${user.name || user.email}!`);
      onAuthSuccess?.(user);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to sign in. Please verify your credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsLoading(true);

    try {
      if (!name.trim()) {
        throw new Error('Please enter your full name');
      }
      if (!email.trim()) {
        throw new Error('Please enter a valid email address');
      }
      if (password.length < 8) {
        throw new Error('Password must be at least 8 characters long');
      }
      if (password !== confirmPassword) {
        throw new Error('Passwords do not match');
      }

      const { user } = await neonAuth.signUp({
        name: name.trim(),
        email: email.trim(),
        password,
        preserveGuestData
      });
      setSuccessMessage(`Account created successfully! Welcome to AIRA, ${user.name}!`);
      onAuthSuccess?.(user);
    } catch (err: any) {
      setErrorMessage(err.message || 'Registration failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSocialSignIn = async (provider: 'google' | 'github') => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsLoading(true);

    try {
      await neonAuth.signInWithSocial({ provider });
    } catch (err: any) {
      if (err?.message?.includes('not supported') || err?.message?.includes('PROVIDER_NOT_SUPPORTED')) {
        setErrorMessage(
          `${provider === 'google' ? 'Google' : 'GitHub'} OAuth is not enabled on this environment. To activate, add provider credentials in Neon Console / neonctl.`
        );
      } else {
        setErrorMessage(err.message || `Failed to initiate ${provider} sign-in.`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleLinkProvider = (provider: 'google' | 'github') => {
    window.location.href = `/api/auth/oauth/${provider}/link`;
  };

  const handleUnlinkProvider = async (provider: 'google' | 'github') => {
    setIsLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch(`/api/auth/providers/${provider}/unlink`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-aira-csrf-protection': '1'
        },
        credentials: 'include'
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to unlink provider');
      }
      setSuccessMessage(`Successfully unlinked ${provider === 'google' ? 'Google' : 'GitHub'} account.`);
      await fetchLinkedProviders();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to unlink provider');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmitRecoveryRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      if (!email.trim()) {
        throw new Error('Please enter your account email');
      }
      const res = await fetch('/api/auth/recovery/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-aira-csrf-protection': '1'
        },
        credentials: 'include',
        body: JSON.stringify({
          claimedEmail: email.trim(),
          provider: 'all',
          contactInfo: recoveryContact.trim() || undefined,
          details: recoveryDetails.trim() || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Recovery request submission failed');
      }
      setSuccessMessage(data.message || 'Recovery request submitted. Ticket logged securely.');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to submit recovery request');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRequestPasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsLoading(true);

    try {
      if (!email.trim()) {
        throw new Error('Please enter the email associated with your account');
      }
      const res = await neonAuth.requestPasswordReset(email.trim());
      setSuccessMessage(res.message);
    } catch (err: any) {
      setErrorMessage(err.message || 'Password reset request failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsLoading(true);

    try {
      if (!recoveryToken.trim()) {
        throw new Error('Please enter the reset token received via email');
      }
      if (newPassword.length < 8) {
        throw new Error('New password must be at least 8 characters');
      }
      const res = await neonAuth.resetPassword({
        token: recoveryToken.trim(),
        newPassword
      });
      setSuccessMessage(res.message || 'Password reset successful! You can now sign in.');
      setActiveTab('signin');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to reset password');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    setIsLoading(true);
    try {
      await neonAuth.signOut();
      setSuccessMessage('Signed out successfully. Guest session active.');
      setActiveTab('signin');
      setServerVerification(null);
    } catch (err: any) {
      setErrorMessage(err.message || 'Sign out failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyServerPrincipal = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await neonAuth.verifyServerIdentity();
      setServerVerification(result);
    } catch (err: any) {
      setErrorMessage(`Server principal verification failed: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
      >
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/60 backdrop-blur-md transition-opacity"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ type: 'spring', duration: 0.35, bounce: 0.15 }}
          className="relative w-full max-w-md bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark rounded-2xl shadow-2xl overflow-hidden z-10"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-claude-border-light dark:border-claude-border-dark">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-claude-terracotta to-[#eb6e4b] flex items-center justify-center text-white shadow-md">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h2 id="auth-modal-title" className="text-base font-bold text-claude-text-light dark:text-white tracking-tight">
                  {currentUser ? 'Persistent Account' : 'Account Authentication'}
                </h2>
                <div className="flex items-center space-x-1.5 mt-0.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  <span className="text-[11px] font-medium text-claude-muted-light dark:text-claude-muted-dark">
                    Direct OAuth (Google & GitHub) · Staging
                  </span>
                </div>
              </div>
            </div>

            <button
              onClick={onClose}
              aria-label="Close dialog"
              className="p-1.5 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Tab Navigation (only when unauthenticated) */}
          {!currentUser && (
            <div className="flex border-b border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/50 dark:bg-claude-surface2-dark/50 p-1 m-4 rounded-xl gap-1">
              <button
                type="button"
                onClick={() => { setActiveTab('signin'); setErrorMessage(null); }}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === 'signin'
                    ? 'bg-claude-surface-light dark:bg-claude-surface-dark text-claude-terracotta dark:text-claude-terracotta shadow-sm'
                    : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => { setActiveTab('signup'); setErrorMessage(null); }}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === 'signup'
                    ? 'bg-claude-surface-light dark:bg-claude-surface-dark text-claude-terracotta dark:text-claude-terracotta shadow-sm'
                    : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white'
                }`}
              >
                Create Account
              </button>
              <button
                type="button"
                onClick={() => { setActiveTab('recovery'); setErrorMessage(null); }}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === 'recovery'
                    ? 'bg-claude-surface-light dark:bg-claude-surface-dark text-claude-terracotta dark:text-claude-terracotta shadow-sm'
                    : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white'
                }`}
              >
                Recovery
              </button>
            </div>
          )}

          {/* Feedback Banners */}
          <div className="px-6 pt-2">
            {errorMessage && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-xs flex items-start space-x-2.5"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
                <span className="leading-relaxed">{errorMessage}</span>
              </motion.div>
            )}

            {successMessage && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs flex items-start space-x-2.5"
              >
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-500" />
                <span className="leading-relaxed">{successMessage}</span>
              </motion.div>
            )}
          </div>

          {/* Modal Body */}
          <div className="p-6 pt-2 space-y-4">
            {/* SIGN IN TAB */}
            {activeTab === 'signin' && !currentUser && (
              <div className="space-y-4">
                {/* Primary Direct OAuth Actions */}
                <div className="space-y-2">
                  <button
                    type="button"
                    id="signin-google-btn"
                    disabled={isLoading}
                    onClick={() => handleSocialSignIn('google')}
                    className="w-full py-2.5 px-4 bg-white hover:bg-stone-50 text-stone-900 border border-stone-300 dark:border-stone-700 font-semibold text-xs rounded-xl shadow-sm transition-all flex items-center justify-center space-x-2.5 disabled:opacity-50"
                  >
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                    </svg>
                    <span>Continue with Google</span>
                  </button>

                  <button
                    type="button"
                    id="signin-github-btn"
                    disabled={isLoading}
                    onClick={() => handleSocialSignIn('github')}
                    className="w-full py-2.5 px-4 bg-stone-900 hover:bg-black text-white border border-stone-800 font-semibold text-xs rounded-xl shadow-sm transition-all flex items-center justify-center space-x-2.5 disabled:opacity-50"
                  >
                    <svg className="w-4 h-4 shrink-0 fill-current" viewBox="0 0 24 24">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                    </svg>
                    <span>Continue with GitHub</span>
                  </button>
                </div>

                <div className="relative my-3">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-claude-border-light dark:border-claude-border-dark" />
                  </div>
                  <div className="relative flex justify-center text-[10px] uppercase">
                    <span className="bg-claude-surface-light dark:bg-claude-surface-dark px-2 text-claude-muted-light dark:text-claude-muted-dark">
                      Or sign in with email credentials
                    </span>
                  </div>
                </div>

                <form onSubmit={handleSignIn} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-claude-text-light dark:text-white mb-1.5">
                      Email address
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 absolute left-3.5 top-3 text-claude-muted-light dark:text-claude-muted-dark" />
                      <input
                        ref={initialFocusRef}
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="name@example.com"
                        className="w-full pl-10 pr-4 py-2.5 bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark rounded-xl text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light dark:placeholder:text-claude-muted-dark outline-none focus:border-claude-terracotta transition-colors"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-semibold text-claude-text-light dark:text-white">
                        Password
                      </label>
                      <button
                        type="button"
                        onClick={() => setActiveTab('recovery')}
                        className="text-[11px] font-medium text-claude-terracotta hover:underline"
                      >
                        Forgot password?
                      </button>
                    </div>
                    <div className="relative">
                      <Lock className="w-4 h-4 absolute left-3.5 top-3 text-claude-muted-light dark:text-claude-muted-dark" />
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full pl-10 pr-10 py-2.5 bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark rounded-xl text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light dark:placeholder:text-claude-muted-dark outline-none focus:border-claude-terracotta transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-3.5 top-3 text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2.5 pt-1">
                    <input
                      type="checkbox"
                      id="signin-preserve-guest"
                      checked={preserveGuestData}
                      onChange={(e) => setPreserveGuestData(e.target.checked)}
                      className="w-4 h-4 rounded text-claude-terracotta border-claude-border-light dark:border-claude-border-dark focus:ring-claude-terracotta"
                    />
                    <label htmlFor="signin-preserve-guest" className="text-xs text-claude-muted-light dark:text-claude-muted-dark select-none cursor-pointer">
                      Preserve current guest workspace conversations
                    </label>
                  </div>

                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full py-2.5 px-4 bg-gradient-to-r from-claude-terracotta to-[#eb6e4b] hover:from-[#d97757] hover:to-[#eb6e4b] text-white font-semibold text-xs rounded-xl shadow-md transition-all flex items-center justify-center space-x-2 disabled:opacity-50"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Authenticating...</span>
                      </>
                    ) : (
                      <>
                        <span>Sign In with Email</span>
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </form>
              </div>
            )}

            {/* SIGN UP TAB */}
            {activeTab === 'signup' && !currentUser && (
              <div className="space-y-4">
                {/* Primary Direct OAuth Actions */}
                <div className="space-y-2">
                  <button
                    type="button"
                    id="signup-google-btn"
                    disabled={isLoading}
                    onClick={() => handleSocialSignIn('google')}
                    className="w-full py-2.5 px-4 bg-white hover:bg-stone-50 text-stone-900 border border-stone-300 dark:border-stone-700 font-semibold text-xs rounded-xl shadow-sm transition-all flex items-center justify-center space-x-2.5 disabled:opacity-50"
                  >
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                    </svg>
                    <span>Create Account with Google</span>
                  </button>

                  <button
                    type="button"
                    id="signup-github-btn"
                    disabled={isLoading}
                    onClick={() => handleSocialSignIn('github')}
                    className="w-full py-2.5 px-4 bg-stone-900 hover:bg-black text-white border border-stone-800 font-semibold text-xs rounded-xl shadow-sm transition-all flex items-center justify-center space-x-2.5 disabled:opacity-50"
                  >
                    <svg className="w-4 h-4 shrink-0 fill-current" viewBox="0 0 24 24">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                    </svg>
                    <span>Create Account with GitHub</span>
                  </button>
                </div>

                <div className="relative my-3">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-claude-border-light dark:border-claude-border-dark" />
                  </div>
                  <div className="relative flex justify-center text-[10px] uppercase">
                    <span className="bg-claude-surface-light dark:bg-claude-surface-dark px-2 text-claude-muted-light dark:text-claude-muted-dark">
                      Or register with email credentials
                    </span>
                  </div>
                </div>

                <form onSubmit={handleSignUp} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-claude-text-light dark:text-white mb-1.5">
                      Full name
                    </label>
                    <div className="relative">
                      <User className="w-4 h-4 absolute left-3.5 top-3 text-claude-muted-light dark:text-claude-muted-dark" />
                      <input
                        ref={initialFocusRef}
                        type="text"
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Jane Doe"
                        className="w-full pl-10 pr-4 py-2.5 bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark rounded-xl text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light dark:placeholder:text-claude-muted-dark outline-none focus:border-claude-terracotta transition-colors"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-claude-text-light dark:text-white mb-1.5">
                      Email address
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 absolute left-3.5 top-3 text-claude-muted-light dark:text-claude-muted-dark" />
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="name@example.com"
                        className="w-full pl-10 pr-4 py-2.5 bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark rounded-xl text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light dark:placeholder:text-claude-muted-dark outline-none focus:border-claude-terracotta transition-colors"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-claude-text-light dark:text-white mb-1.5">
                      Password (min. 8 characters)
                    </label>
                    <div className="relative">
                      <Lock className="w-4 h-4 absolute left-3.5 top-3 text-claude-muted-light dark:text-claude-muted-dark" />
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        minLength={8}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full pl-10 pr-10 py-2.5 bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark rounded-xl text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light dark:placeholder:text-claude-muted-dark outline-none focus:border-claude-terracotta transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-3.5 top-3 text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-claude-text-light dark:text-white mb-1.5">
                      Confirm password
                    </label>
                    <div className="relative">
                      <Lock className="w-4 h-4 absolute left-3.5 top-3 text-claude-muted-light dark:text-claude-muted-dark" />
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        minLength={8}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full pl-10 pr-4 py-2.5 bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark rounded-xl text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light dark:placeholder:text-claude-muted-dark outline-none focus:border-claude-terracotta transition-colors"
                      />
                    </div>
                  </div>

                  <div className="flex items-center space-x-2.5 pt-1">
                    <input
                      type="checkbox"
                      id="signup-preserve-guest"
                      checked={preserveGuestData}
                      onChange={(e) => setPreserveGuestData(e.target.checked)}
                      className="w-4 h-4 rounded text-claude-terracotta border-claude-border-light dark:border-claude-border-dark focus:ring-claude-terracotta"
                    />
                    <label htmlFor="signup-preserve-guest" className="text-xs text-claude-muted-light dark:text-claude-muted-dark select-none cursor-pointer">
                      Link existing guest conversations to this new account
                    </label>
                  </div>

                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full py-2.5 px-4 bg-gradient-to-r from-claude-terracotta to-[#eb6e4b] hover:from-[#d97757] hover:to-[#eb6e4b] text-white font-semibold text-xs rounded-xl shadow-md transition-all flex items-center justify-center space-x-2 disabled:opacity-50"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Creating Account...</span>
                      </>
                    ) : (
                      <>
                        <span>Create Account with Email</span>
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </form>
              </div>
            )}

            {/* RECOVERY TAB */}
            {activeTab === 'recovery' && !currentUser && (
              <div className="space-y-5">
                {/* Section A: Google & GitHub Official Recovery */}
                <div className="p-3.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark space-y-2.5">
                  <div className="text-xs font-bold text-claude-text-light dark:text-white flex items-center space-x-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-500" />
                    <span>OAuth Account Recovery</span>
                  </div>
                  <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark leading-relaxed">
                    If you signed up with Google or GitHub, use your provider&apos;s recovery center to restore access:
                  </p>
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <a
                      href="https://accounts.google.com/signin/recovery"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 rounded-lg text-[11px] font-semibold text-claude-text-light dark:text-white flex items-center justify-center space-x-1.5 transition-colors border border-claude-border-light dark:border-claude-border-dark"
                    >
                      <span>Google Recovery</span>
                      <ExternalLink className="w-3 h-3 text-claude-muted-light dark:text-claude-muted-dark" />
                    </a>
                    <a
                      href="https://github.com/password_reset"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 rounded-lg text-[11px] font-semibold text-claude-text-light dark:text-white flex items-center justify-center space-x-1.5 transition-colors border border-claude-border-light dark:border-claude-border-dark"
                    >
                      <span>GitHub Recovery</span>
                      <ExternalLink className="w-3 h-3 text-claude-muted-light dark:text-claude-muted-dark" />
                    </a>
                  </div>
                  <div className="text-[10px] text-claude-muted-light dark:text-claude-muted-dark italic pt-1">
                    Tip: If you previously linked both Google and GitHub, you can sign in directly using your alternate provider!
                  </div>
                </div>

                {/* Section B: Audited Support Request (Lost all providers) */}
                <form onSubmit={handleSubmitRecoveryRequest} className="p-3.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark space-y-3">
                  <div className="text-xs font-bold text-claude-text-light dark:text-white flex items-center space-x-1.5">
                    <KeyRound className="w-4 h-4 text-claude-terracotta" />
                    <span>Lost Access to Every Provider</span>
                  </div>
                  <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark leading-relaxed">
                    Submit an audited recovery request. Support requires cryptographically verified identity proof before recovery.
                  </p>
                  <div>
                    <label className="block text-[11px] font-semibold text-claude-text-light dark:text-white mb-1">
                      Registered account email
                    </label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="account@example.com"
                      className="w-full px-3 py-1.5 bg-black/5 dark:bg-white/5 border border-claude-border-light dark:border-claude-border-dark rounded-lg text-xs text-claude-text-light dark:text-white outline-none focus:border-claude-terracotta"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-claude-text-light dark:text-white mb-1">
                      Alternate contact email or phone
                    </label>
                    <input
                      type="text"
                      value={recoveryContact}
                      onChange={(e) => setRecoveryContact(e.target.value)}
                      placeholder="backup-contact@example.com"
                      className="w-full px-3 py-1.5 bg-black/5 dark:bg-white/5 border border-claude-border-light dark:border-claude-border-dark rounded-lg text-xs text-claude-text-light dark:text-white outline-none focus:border-claude-terracotta"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-claude-text-light dark:text-white mb-1">
                      Reason / account ownership details
                    </label>
                    <textarea
                      rows={2}
                      value={recoveryDetails}
                      onChange={(e) => setRecoveryDetails(e.target.value)}
                      placeholder="Describe what occurred with your linked OAuth accounts"
                      className="w-full px-3 py-1.5 bg-black/5 dark:bg-white/5 border border-claude-border-light dark:border-claude-border-dark rounded-lg text-xs text-claude-text-light dark:text-white outline-none focus:border-claude-terracotta resize-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full py-2 px-3 bg-claude-terracotta text-white font-semibold text-xs rounded-lg shadow-sm transition-colors flex items-center justify-center space-x-1.5 disabled:opacity-50"
                  >
                    {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                    <span>Submit Audited Recovery Request</span>
                  </button>
                </form>

                {/* Section C: Legacy Email/Password Recovery */}
                <div className="border-t border-claude-border-light dark:border-claude-border-dark pt-3">
                  <div className="text-[11px] font-semibold text-claude-muted-light dark:text-claude-muted-dark mb-2">
                    Legacy email/password reset:
                  </div>
                  <form onSubmit={handleRequestPasswordReset} className="space-y-2 mb-3">
                    <button
                      type="submit"
                      disabled={isLoading}
                      className="w-full py-1.5 px-3 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 border border-claude-border-light dark:border-claude-border-dark text-claude-text-light dark:text-white font-semibold text-xs rounded-lg transition-colors flex items-center justify-center space-x-1.5"
                    >
                      <span>Send Password Reset Email</span>
                    </button>
                  </form>

                  <form onSubmit={handleResetPassword} className="space-y-2 pt-2 border-t border-dashed border-claude-border-light dark:border-claude-border-dark">
                    <div className="text-[10px] text-claude-muted-light dark:text-claude-muted-dark">
                      Have a reset token?
                    </div>
                    <input
                      type="text"
                      value={recoveryToken}
                      onChange={(e) => setRecoveryToken(e.target.value)}
                      placeholder="Enter reset token"
                      className="w-full px-2.5 py-1.5 bg-black/5 dark:bg-white/5 border border-claude-border-light dark:border-claude-border-dark rounded-lg text-xs text-claude-text-light dark:text-white outline-none focus:border-claude-terracotta"
                    />
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="New password (min. 8 chars)"
                      className="w-full px-2.5 py-1.5 bg-black/5 dark:bg-white/5 border border-claude-border-light dark:border-claude-border-dark rounded-lg text-xs text-claude-text-light dark:text-white outline-none focus:border-claude-terracotta"
                    />
                    <button
                      type="submit"
                      disabled={isLoading || !recoveryToken.trim() || !newPassword}
                      className="w-full py-1.5 px-3 bg-claude-terracotta/90 hover:bg-claude-terracotta text-white font-semibold text-xs rounded-lg transition-colors flex items-center justify-center space-x-1.5 disabled:opacity-50"
                    >
                      <span>Complete Password Reset</span>
                    </button>
                  </form>
                </div>
              </div>
            )}

            {/* MY ACCOUNT PROFILE TAB */}
            {currentUser && (
              <div className="space-y-4">
                <div className="p-4 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark space-y-3">
                  <div className="flex items-center space-x-3">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-claude-terracotta to-[#eb6e4b] flex items-center justify-center text-white font-bold text-sm shadow-md overflow-hidden">
                      {currentUser.image ? (
                        <img src={currentUser.image} alt={currentUser.name || 'User'} className="w-full h-full object-cover" />
                      ) : (
                        currentUser.name ? currentUser.name.slice(0, 2).toUpperCase() : 'AI'
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-claude-text-light dark:text-white truncate">
                        {currentUser.name}
                      </div>
                      <div className="text-xs text-claude-muted-light dark:text-claude-muted-dark truncate">
                        {currentUser.email || 'Private / Unlisted Email'}
                      </div>
                      <div className="mt-1 flex items-center space-x-2">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                          Direct OAuth Verified Account
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-claude-border-light dark:border-claude-border-dark text-[11px] text-claude-muted-light dark:text-claude-muted-dark space-y-1">
                    <div className="flex justify-between">
                      <span>Server Principal ID:</span>
                      <span className="font-mono text-claude-text-light dark:text-white truncate max-w-[200px]">
                        {currentUser.id}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Auth Engine:</span>
                      <span className="font-medium text-claude-text-light dark:text-white">Direct Google & GitHub OAuth</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Session Persistence:</span>
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">HttpOnly Secure Cookie</span>
                    </div>
                  </div>
                </div>

                {/* Linked OAuth Providers Section */}
                <div className="p-3.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark space-y-2.5">
                  <div className="text-xs font-bold text-claude-text-light dark:text-white">
                    Linked Authentication Providers
                  </div>
                  <div className="space-y-2">
                    {/* Google Provider Row */}
                    <div className="flex items-center justify-between p-2 rounded-lg bg-black/5 dark:bg-white/5 border border-claude-border-light dark:border-claude-border-dark">
                      <div className="flex items-center space-x-2">
                        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                        </svg>
                        <span className="text-xs font-semibold text-claude-text-light dark:text-white">Google</span>
                      </div>
                      {linkedProviders.some(p => p.provider === 'google') ? (
                        <div className="flex items-center space-x-2">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-medium">Linked</span>
                          <button
                            type="button"
                            disabled={isLoading || linkedProviders.length <= 1}
                            onClick={() => handleUnlinkProvider('google')}
                            title={linkedProviders.length <= 1 ? 'Cannot unlink only remaining login method' : 'Unlink Google Account'}
                            className="text-[10px] text-red-500 hover:underline disabled:opacity-40 disabled:no-underline"
                          >
                            Unlink
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() => handleLinkProvider('google')}
                          className="px-2.5 py-1 bg-white hover:bg-stone-100 text-stone-900 border border-stone-300 rounded text-[11px] font-semibold transition"
                        >
                          Link Google
                        </button>
                      )}
                    </div>

                    {/* GitHub Provider Row */}
                    <div className="flex items-center justify-between p-2 rounded-lg bg-black/5 dark:bg-white/5 border border-claude-border-light dark:border-claude-border-dark">
                      <div className="flex items-center space-x-2">
                        <svg className="w-4 h-4 shrink-0 fill-current" viewBox="0 0 24 24">
                          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                        </svg>
                        <span className="text-xs font-semibold text-claude-text-light dark:text-white">GitHub</span>
                      </div>
                      {linkedProviders.some(p => p.provider === 'github') ? (
                        <div className="flex items-center space-x-2">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-medium">Linked</span>
                          <button
                            type="button"
                            disabled={isLoading || linkedProviders.length <= 1}
                            onClick={() => handleUnlinkProvider('github')}
                            title={linkedProviders.length <= 1 ? 'Cannot unlink only remaining login method' : 'Unlink GitHub Account'}
                            className="text-[10px] text-red-500 hover:underline disabled:opacity-40 disabled:no-underline"
                          >
                            Unlink
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() => handleLinkProvider('github')}
                          className="px-2.5 py-1 bg-stone-900 hover:bg-black text-white border border-stone-800 rounded text-[11px] font-semibold transition"
                        >
                          Link GitHub
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {serverVerification && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-700 dark:text-emerald-300 space-y-1 font-mono"
                  >
                    <div className="font-bold flex items-center space-x-1.5 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Live Server Principal Verified</span>
                    </div>
                    <div>Status: {serverVerification.status}</div>
                    <div>Principal: {serverVerification.userId}</div>
                    <div>Provider: {serverVerification.provider}</div>
                  </motion.div>
                )}

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleVerifyServerPrincipal}
                    disabled={isLoading}
                    className="flex-1 py-2.5 px-3 bg-claude-surface2-light dark:bg-claude-surface2-dark hover:bg-black/5 dark:hover:bg-white/5 border border-claude-border-light dark:border-claude-border-dark text-claude-text-light dark:text-white font-semibold text-xs rounded-xl transition-colors flex items-center justify-center space-x-1.5"
                  >
                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
                    <span>Verify Live Server Principal</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleSignOut}
                    disabled={isLoading}
                    className="py-2.5 px-4 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 border border-red-500/30 font-semibold text-xs rounded-xl transition-colors flex items-center justify-center space-x-1.5"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Sign Out</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Footer Information */}
          <div className="px-6 py-3.5 bg-claude-surface2-light/60 dark:bg-claude-surface2-dark/60 border-t border-claude-border-light dark:border-claude-border-dark flex items-center justify-between text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
            <span className="flex items-center space-x-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
              <span>Ed25519 Cryptographically Bound</span>
            </span>
            <span className="font-mono text-[10px]">v2026.2.0</span>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
