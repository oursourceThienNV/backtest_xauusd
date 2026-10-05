'use client';
import {useEffect} from 'react';
import {useRouter} from 'next/navigation';
export default function Home(){const router=useRouter();useEffect(()=>{router.replace(localStorage.getItem('access_token')?'/backtest':'/login')},[router]);return null}
