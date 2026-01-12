import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyACXGEaLw8HsqtqUPr8kAvbbNz_UNCrKjM",
  authDomain: "kolonakufiri.firebaseapp.com",
  projectId: "kolonakufiri",
  storageBucket: "kolonakufiri.firebasestorage.app",
  messagingSenderId: "470117597210",
  appId: "1:470117597210:web:66a251b268cea8cefe11a3",
  measurementId: "G-0FFECN7CRZ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// ⬇⬇⬇ KJO ËSHTË KRITIKE
export const db = getFirestore(app);