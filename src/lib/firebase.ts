/**
 * Firebase Client SDK Integration & State Synchronization
 * Architecture: agency-backend-architect & agency-realtime-collaboration-engineer
 * Security: agency-cloud-security-architect
 */

import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import {
  getAuth,
  signInAnonymously,
  User,
  Auth
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  Firestore,
  serverTimestamp,
} from 'firebase/firestore';
import { getStorage, FirebaseStorage } from 'firebase/storage';
import type { Conversation, Project, Artifact } from '../types';

// Read config from Vite env or provide sensible local defaults
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyDemoAiraWorkspaceKey00000000000000',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'aira-workspace-demo.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'aira-workspace-demo',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'aira-workspace-demo.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '123456789012',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:123456789012:web:abcdef1234567890',
};

// Initialize Firebase App safely (singleton)
export const app: FirebaseApp = !getApps().length ? initializeApp(firebaseConfig) : getApp();
export const auth: Auth = getAuth(app);
export const db: Firestore = getFirestore(app);
export const storage: FirebaseStorage = getStorage(app);

/**
 * Ensure an authenticated session exists (Anonymous auth for zero-barrier onboarding)
 */
export async function ensureAuthenticatedUser(): Promise<User | null> {
  if (auth.currentUser) return auth.currentUser;
  try {
    const cred = await signInAnonymously(auth);
    return cred.user;
  } catch (err) {
    console.warn('Firebase anonymous authentication deferred (using local mode):', err);
    return null;
  }
}

/**
 * Synchronize a Conversation to Cloud Firestore
 */
export async function syncConversationToFirestore(userId: string, conv: Conversation): Promise<void> {
  try {
    const convRef = doc(db, 'conversations', conv.id);
    await setDoc(convRef, {
      id: conv.id,
      userId,
      title: conv.title,
      projectId: conv.projectId || null,
      isPinned: Boolean(conv.isPinned),
      messages: conv.messages,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt || Date.now(),
      syncedAt: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.warn('Failed to sync conversation to Firestore:', err);
  }
}

/**
 * Fetch All Conversations for a User
 */
export async function getFirestoreConversations(userId: string): Promise<Conversation[]> {
  try {
    const q = query(
      collection(db, 'conversations'),
      where('userId', '==', userId),
      orderBy('updatedAt', 'desc')
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => d.data() as Conversation);
  } catch (err) {
    console.warn('Failed to fetch conversations from Firestore:', err);
    return [];
  }
}

/**
 * Real-time subscription to user conversations
 */
export function subscribeToConversations(
  userId: string,
  onUpdate: (conversations: Conversation[]) => void
): () => void {
  try {
    const q = query(
      collection(db, 'conversations'),
      where('userId', '==', userId),
      orderBy('updatedAt', 'desc')
    );
    return onSnapshot(q, (snapshot) => {
      const convs = snapshot.docs.map(doc => doc.data() as Conversation);
      onUpdate(convs);
    }, (error) => {
      console.warn('Firestore subscription error:', error);
    });
  } catch (err) {
    console.warn('Failed to subscribe to Firestore conversations:', err);
    return () => {};
  }
}

/**
 * Synchronize a Project to Cloud Firestore
 */
export async function syncProjectToFirestore(userId: string, project: Project): Promise<void> {
  try {
    const projRef = doc(db, 'projects', project.id);
    await setDoc(projRef, {
      id: project.id,
      userId,
      name: project.name,
      description: project.description,
      instructions: project.instructions,
      docs: project.docs,
      createdAt: project.createdAt,
      syncedAt: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.warn('Failed to sync project to Firestore:', err);
  }
}

/**
 * Synchronize an Artifact & its Versions to Cloud Firestore
 */
export async function syncArtifactToFirestore(userId: string, artifact: Artifact): Promise<void> {
  try {
    const artRef = doc(db, 'artifacts', artifact.id);
    await setDoc(artRef, {
      id: artifact.id,
      userId,
      title: artifact.title,
      type: artifact.type,
      language: artifact.language || 'html',
      version: artifact.version,
      content: artifact.content,
      versions: artifact.versions,
      syncedAt: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.warn('Failed to sync artifact to Firestore:', err);
  }
}
