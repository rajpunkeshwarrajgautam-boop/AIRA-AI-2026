import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { auth } from '../../lib/firebase';
export const firebaseConfigured = Boolean(import.meta.env.VITE_FIREBASE_PROJECT_ID && import.meta.env.VITE_FIREBASE_API_KEY);
export async function botToken() {
  if (!firebaseConfigured) return undefined;
  await auth.authStateReady();
  return auth.currentUser?.getIdToken();
}
export async function signInBot() {
  if (!firebaseConfigured) throw new Error('Configure the existing AIRA Firebase project before signing in.');
  await signInWithPopup(auth, new GoogleAuthProvider());
}
