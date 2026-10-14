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
  ArrowRight
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

  useEffect(() => {
    const unsubscribe = neonAuth.onAuthStateChange((user, session) => {
      setCurrentUser(user);
      setCurrentSession(session);
      if (user) {
        setActiveTab('profile');
      }
    });
    return () => unsubscribe();
  }, []);

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
                    Neon Managed Auth · Staging
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
                      <span>Sign In to AIRA</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>
            )}

            {/* SIGN UP TAB */}
            {activeTab === 'signup' && !currentUser && (
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
                      <span>Create Account & Sync</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>
            )}

            {/* RECOVERY TAB */}
            {activeTab === 'recovery' && !currentUser && (
              <div className="space-y-6">
                <form onSubmit={handleRequestPasswordReset} className="space-y-3">
                  <div className="text-xs text-claude-muted-light dark:text-claude-muted-dark">
                    Step 1: Request password reset instructions
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-claude-text-light dark:text-white mb-1.5">
                      Account email
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 absolute left-3.5 top-3 text-claude-muted-light dark:text-claude-muted-dark" />
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="name@example.com"
                        className="w-full pl-10 pr-4 py-2 bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark rounded-xl text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light dark:placeholder:text-claude-muted-dark outline-none focus:border-claude-terracotta transition-colors"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full py-2 px-3 bg-claude-surface2-light dark:bg-claude-surface2-dark hover:bg-black/5 dark:hover:bg-white/5 border border-claude-border-light dark:border-claude-border-dark text-claude-text-light dark:text-white font-semibold text-xs rounded-xl transition-colors flex items-center justify-center space-x-1.5"
                  >
                    <span>Send Reset Email</span>
                  </button>
                </form>

                <div className="border-t border-claude-border-light dark:border-claude-border-dark pt-4">
                  <form onSubmit={handleResetPassword} className="space-y-3">
                    <div className="text-xs text-claude-muted-light dark:text-claude-muted-dark">
                      Step 2: Enter recovery token and new password
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-claude-text-light dark:text-white mb-1.5">
                        Recovery token
                      </label>
                      <div className="relative">
                        <KeyRound className="w-4 h-4 absolute left-3.5 top-3 text-claude-muted-light dark:text-claude-muted-dark" />
                        <input
                          type="text"
                          required
                          value={recoveryToken}
                          onChange={(e) => setRecoveryToken(e.target.value)}
                          placeholder="Paste token received"
                          className="w-full pl-10 pr-4 py-2 bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark rounded-xl text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light dark:placeholder:text-claude-muted-dark outline-none focus:border-claude-terracotta transition-colors"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-claude-text-light dark:text-white mb-1.5">
                        New password
                      </label>
                      <div className="relative">
                        <Lock className="w-4 h-4 absolute left-3.5 top-3 text-claude-muted-light dark:text-claude-muted-dark" />
                        <input
                          type="password"
                          required
                          minLength={8}
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="••••••••"
                          className="w-full pl-10 pr-4 py-2 bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark rounded-xl text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light dark:placeholder:text-claude-muted-dark outline-none focus:border-claude-terracotta transition-colors"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      disabled={isLoading}
                      className="w-full py-2 px-3 bg-claude-terracotta text-white font-semibold text-xs rounded-xl shadow-sm transition-colors flex items-center justify-center space-x-1.5"
                    >
                      <span>Update Password</span>
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
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-claude-terracotta to-[#eb6e4b] flex items-center justify-center text-white font-bold text-sm shadow-md">
                      {currentUser.name ? currentUser.name.slice(0, 2).toUpperCase() : 'AI'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-claude-text-light dark:text-white truncate">
                        {currentUser.name}
                      </div>
                      <div className="text-xs text-claude-muted-light dark:text-claude-muted-dark truncate">
                        {currentUser.email}
                      </div>
                      <div className="mt-1 flex items-center space-x-2">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                          Verified Neon Account
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-claude-border-light dark:border-claude-border-dark text-[11px] text-claude-muted-light dark:text-claude-muted-dark space-y-1">
                    <div className="flex justify-between">
                      <span>Server Principal:</span>
                      <span className="font-mono text-claude-text-light dark:text-white truncate max-w-[200px]">
                        neon_user_{currentUser.id}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Auth Provider:</span>
                      <span className="font-medium text-claude-text-light dark:text-white">Better Auth (Neon)</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Cross-Device Sync:</span>
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">Active</span>
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
