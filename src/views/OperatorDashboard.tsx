import React, { useState, useEffect, useRef } from 'react';
import {
  BellRing,
  Send,
  Clock,
  CheckCircle2,
  Monitor,
  Star,
  RefreshCw,
  RotateCcw,
  Activity,
  AlertTriangle,
  ChevronRight,
  Volume2,
  VolumeX,
  Stethoscope,
  UserCheck,
  ArrowRight,
  Hash,
  User as UserIcon,
  Check,
  X,
  Layers,
  PhoneCall,
  UserX,
  ShieldAlert,
} from 'lucide-react';
import { api } from '../lib/api';
import { User, Operator, ConsultationQueueItem, GuicheAttendanceSession, GuicheTicketState } from '../types';
import { playCallAlert, stopCallAlert, unlockAudio, preloadPhraseAudio } from '../lib/audio';
import { PlayerDiagnosticView, DiagnosticPlayerData } from '../components/PlayerDiagnosticView';

interface OperatorDashboardProps {
  currentUser?: User | null;
  showToast: (type: 'success' | 'error' | 'info', message: string) => void;
  onOpenPlayerSimulation?: (code: string) => void;
}

export const OperatorDashboard: React.FC<OperatorDashboardProps> = ({
  currentUser,
  showToast,
  onOpenPlayerSimulation,
}) => {
  // Define initial active tab based on logged-in operator profile ('guiche' vs 'consultorio')
  const [activeTab, setActiveTab] = useState<'guiche' | 'consultorio' | 'diagnostic'>(() => {
    if (currentUser?.operator_profile === 'consultorio') {
      return 'consultorio';
    }
    return 'guiche';
  });

  const [players, setPlayers] = useState<DiagnosticPlayerData[]>([]);
  const [currentOperator, setCurrentOperator] = useState<Operator | null>(null);
  const [consultorios, setConsultorios] = useState<Operator[]>([]);
  const [guiches, setGuiches] = useState<Operator[]>([]);
  const [consultationQueue, setConsultationQueue] = useState<ConsultationQueueItem[]>([]);

  // Active Guichê and Active Consultório selections
  const [selectedGuicheId, setSelectedGuicheId] = useState<string>('');
  const [selectedConsultorioId, setSelectedConsultorioId] = useState<string>('');

  // ----------------------------------------------------
  // SEQUENTIAL TICKET & SHARED COUNTER STATE FOR GUICHÊ
  // ----------------------------------------------------
  const [nextTicketNumber, setNextTicketNumber] = useState<string>('001');
  const [activeGuicheSession, setActiveGuicheSession] = useState<GuicheAttendanceSession | null>(() => {
    try {
      const saved = localStorage.getItem('indoor_active_guiche_session');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [remainingRecalls, setRemainingRecalls] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('indoor_active_guiche_session');
      if (saved) {
        const parsed = JSON.parse(saved);
        return Math.max(0, 3 - (parsed.call_count || 1));
      }
    } catch {}
    return 2;
  });
  const [isPriorityNext, setIsPriorityNext] = useState<boolean>(false);
  const [isCallingNext, setIsCallingNext] = useState<boolean>(false);
  const [isRecalling, setIsRecalling] = useState<boolean>(false);
  const [isMarkingAbsent, setIsMarkingAbsent] = useState<boolean>(false);

  useEffect(() => {
    try {
      if (activeGuicheSession) {
        localStorage.setItem('indoor_active_guiche_session', JSON.stringify(activeGuicheSession));
      } else {
        localStorage.removeItem('indoor_active_guiche_session');
      }
    } catch {}
  }, [activeGuicheSession]);

  // Manual ticket toggle (optional override)
  const [manualTicketOpen, setManualTicketOpen] = useState<boolean>(false);
  const [manualTicketValue, setManualTicketValue] = useState<string>('');

  // Form state in Guichê to forward active ticket to a Consultório
  const [patientName, setPatientName] = useState<string>('');
  const [targetConsultorioId, setTargetConsultorioId] = useState<string>('');
  const [ticketNotes, setTicketNotes] = useState<string>('');
  const [isSendingToConsultorio, setIsSendingToConsultorio] = useState<boolean>(false);

  // Calling state for Consultório queue items
  const [callingQueueItemId, setCallingQueueItemId] = useState<string | null>(null);

  // Persistent Player selection via localStorage
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>(() => {
    try {
      return localStorage.getItem('indoor_op_player_id') || '';
    } catch {
      return '';
    }
  });

  // Target for deep diagnosis
  const [diagnosticPlayerId, setDiagnosticPlayerId] = useState<string>('');

  const [duration, setDuration] = useState<number>(10);
  const [isPreviewingVoice, setIsPreviewingVoice] = useState<boolean>(false);
  const [playLocalSound, setPlayLocalSound] = useState<boolean>(() => {
    try {
      return localStorage.getItem('indoor_op_local_sound') !== 'false';
    } catch {
      return true;
    }
  });
  const [lastCallDelivered, setLastCallDelivered] = useState<boolean | null>(null);
  const [lastCallTime, setLastCallTime] = useState<string | null>(null);

  // Update tab if currentUser changes (e.g., via Quick Role Switcher)
  useEffect(() => {
    if (currentUser?.operator_profile === 'consultorio') {
      setActiveTab('consultorio');
      if (currentUser.operator_id) {
        setSelectedConsultorioId(currentUser.operator_id);
      }
    } else if (currentUser?.operator_profile === 'guiche') {
      setActiveTab('guiche');
      if (currentUser.operator_id) {
        setSelectedGuicheId(currentUser.operator_id);
      }
    }
  }, [currentUser?.id, currentUser?.operator_profile, currentUser?.operator_id]);

  // Sync chosen player persistently in localStorage
  useEffect(() => {
    try {
      if (selectedPlayerId) {
        localStorage.setItem('indoor_op_player_id', selectedPlayerId);
      }
    } catch {}
  }, [selectedPlayerId]);

  // Pre-fetch next call phrase TTS voice buffer in background
  useEffect(() => {
    const activeGuiche =
      guiches.find((g) => g.id === selectedGuicheId) ||
      (currentOperator?.profile === 'guiche' ? currentOperator : null) ||
      guiches[0];
    const phrase = isPriorityNext
      ? `Senha preferencial P${nextTicketNumber}, comparecer ao ${activeGuiche?.name || 'Guichê 01'}`
      : `Senha ${nextTicketNumber}, comparecer ao ${activeGuiche?.name || 'Guichê 01'}`;
    preloadPhraseAudio(phrase).catch(() => {});
  }, [nextTicketNumber, selectedGuicheId, guiches, currentOperator, isPriorityNext]);

  // Load Main Data & Synchronized Guichê State
  const loadData = async () => {
    try {
      const res = await api.getOperatorDashboard();
      const playerList = Array.isArray(res?.players) ? res.players : [];
      setPlayers(playerList);
      if (playerList.length > 0) {
        setSelectedPlayerId((prev) => {
          const match = playerList.find((p) => p.id === prev);
          const validId = match ? match.id : playerList[0].id;
          try {
            localStorage.setItem('indoor_op_player_id', validId);
          } catch {}
          return validId;
        });
      }

      const consList = Array.isArray(res?.consultorios) ? res.consultorios : [];
      const guicheList = Array.isArray(res?.guiches) ? res.guiches : [];
      const queueList = Array.isArray(res?.consultationQueue) ? res.consultationQueue : [];

      setConsultorios(consList);
      setGuiches(guicheList);
      setConsultationQueue(queueList);

      if (res?.currentOperator) {
        setCurrentOperator(res.currentOperator);
        if (res.currentOperator.profile === 'consultorio') {
          setSelectedConsultorioId((prev) => prev || res.currentOperator!.id);
        } else {
          setSelectedGuicheId((prev) => prev || res.currentOperator!.id);
        }
      }

      if (consList.length > 0) {
        setTargetConsultorioId((prev) => {
          const exists = consList.some((c) => c.id === prev);
          return exists ? prev : consList[0].id;
        });
        setSelectedConsultorioId((prev) => {
          const exists = consList.some((c) => c.id === prev);
          if (exists) return prev;
          if (res?.currentOperator?.profile === 'consultorio') return res.currentOperator.id;
          return consList[0].id;
        });
      }

      const activeGuiche =
        guiches.find((g) => g.id === selectedGuicheId) ||
        (res?.currentOperator?.profile === 'guiche' ? res.currentOperator : null) ||
        guiches[0];
      const effectiveGuicheId =
        selectedGuicheId ||
        (res?.currentOperator?.profile === 'guiche' ? res.currentOperator.id : '') ||
        (guicheList[0] ? guicheList[0].id : '');

      if (effectiveGuicheId) {
        setSelectedGuicheId((prev) => prev || effectiveGuicheId);
        // Load Guichê Sequential Ticket State
        api.getGuicheState(effectiveGuicheId)
          .then((stateRes: any) => {
            if (stateRes) {
              const nextNum = stateRes.next_ticket_number || stateRes.nextTicketNumber || '001';
              setNextTicketNumber(nextNum);
              const serverSession = stateRes.active_session !== undefined ? stateRes.active_session : stateRes.activeSession;
              if (serverSession && (serverSession.status === 'called' || serverSession.status === 'in_attendance')) {
                setActiveGuicheSession(serverSession);
                const recalls = typeof stateRes.remaining_recalls === 'number'
                  ? stateRes.remaining_recalls
                  : typeof stateRes.remainingRecalls === 'number'
                  ? stateRes.remainingRecalls
                  : Math.max(0, 3 - serverSession.call_count);
                setRemainingRecalls(recalls);
              } else if (serverSession === null || (serverSession && (serverSession.status === 'completed' || serverSession.status === 'forwarded' || serverSession.status === 'absent'))) {
                setActiveGuicheSession(null);
                setRemainingRecalls(2);
              }
            }
          })
          .catch(() => {});
      }
    } catch (err: any) {
      showToast('error', err.message || 'Erro ao carregar dados de atendimento.');
    }
  };

  useEffect(() => {
    loadData();
    // Poll player status, consultation queue and ticket counter every 3s
    const interval = setInterval(() => {
      const activeGuiche =
        guiches.find((g) => g.id === selectedGuicheId) ||
        (currentOperator?.profile === 'guiche' ? currentOperator : null) ||
        guiches[0];
      const effectiveGuicheId = selectedGuicheId || activeGuiche?.id || currentOperator?.id;

      if (effectiveGuicheId) {
        api.getGuicheState(effectiveGuicheId)
          .then((stateRes: any) => {
            if (stateRes) {
              const nextNum = stateRes.next_ticket_number || stateRes.nextTicketNumber || '001';
              setNextTicketNumber(nextNum);
              const serverSession = stateRes.active_session !== undefined ? stateRes.active_session : stateRes.activeSession;
              if (serverSession && (serverSession.status === 'called' || serverSession.status === 'in_attendance')) {
                setActiveGuicheSession(serverSession);
                const recalls = typeof stateRes.remaining_recalls === 'number'
                  ? stateRes.remaining_recalls
                  : typeof stateRes.remainingRecalls === 'number'
                  ? stateRes.remainingRecalls
                  : Math.max(0, 3 - serverSession.call_count);
                setRemainingRecalls(recalls);
              } else if (serverSession === null || (serverSession && (serverSession.status === 'completed' || serverSession.status === 'forwarded' || serverSession.status === 'absent'))) {
                setActiveGuicheSession(null);
                setRemainingRecalls(2);
              }
              if (Array.isArray(stateRes.consultorios)) setConsultorios(stateRes.consultorios);
              if (Array.isArray(stateRes.guiches)) setGuiches(stateRes.guiches);
            }
          })
          .catch(() => {});
      }

      api.getOperatorDashboard()
        .then((res) => {
          const playerList = Array.isArray(res?.players) ? res.players : [];
          setPlayers(playerList);
          if (Array.isArray(res?.consultationQueue)) setConsultationQueue(res.consultationQueue);
        })
        .catch(() => {});
    }, 3000);

    // Instant cross-tab synchronization via BroadcastChannel
    let bc: BroadcastChannel | null = null;
    try {
      if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
        bc = new BroadcastChannel('indoor_consultation_queue');
        bc.onmessage = (evt) => {
          if (evt.data?.type === 'QUEUE_UPDATED' || evt.data?.type === 'TICKET_CALLED') {
            loadData();
          }
        };
      }
    } catch {}

    return () => {
      clearInterval(interval);
      if (bc) {
        try {
          bc.close();
        } catch {}
      }
    };
  }, [selectedGuicheId]);

  const broadcastCallToPlayers = (call: PlayerCall) => {
    try {
      if (typeof window !== 'undefined') {
        if ('BroadcastChannel' in window) {
          const bc = new BroadcastChannel('indoor_media_calls');
          bc.postMessage({ type: 'CALL_EVENT', call });
          setTimeout(() => {
            try {
              bc.close();
            } catch {}
          }, 400);
        }
        try {
          localStorage.setItem('indoor_last_call', JSON.stringify({ call, timestamp: Date.now() }));
        } catch {}
      }
    } catch {}
  };

  const broadcastQueueUpdate = () => {
    try {
      if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
        const bc = new BroadcastChannel('indoor_consultation_queue');
        bc.postMessage({ type: 'TICKET_CALLED', timestamp: Date.now() });
        setTimeout(() => {
          try {
            bc.close();
          } catch {}
        }, 200);
      }
    } catch {}
  };

  // ----------------------------------------------------
  // GUICHÊ: CHAMAR PRÓXIMA SENHA SEQUENCIAL
  // ----------------------------------------------------
  const handleCallNextTicket = async (isPriorityOverride?: boolean) => {
    const targetPlayer = players.find((p) => p.id === selectedPlayerId) || players[0];
    const targetPlayerId = targetPlayer?.id || selectedPlayerId;
    if (!targetPlayerId) {
      showToast('error', 'Selecione uma TV de exibição para anunciar a senha.');
      return;
    }

    const activeGuiche =
      guiches.find((g) => g.id === selectedGuicheId) ||
      (currentOperator?.profile === 'guiche' ? currentOperator : null) ||
      guiches[0];

    const priorityFlag = isPriorityOverride !== undefined ? isPriorityOverride : isPriorityNext;
    const manualToSend = manualTicketOpen && manualTicketValue.trim() ? manualTicketValue.trim() : undefined;

    unlockAudio();
    setIsCallingNext(true);

    try {
      const res = await api.callNextGuicheTicket({
        guiche_id: activeGuiche?.id,
        guiche_name: activeGuiche?.name || 'Guichê 01',
        playerId: targetPlayerId,
        is_priority: priorityFlag,
        manual_ticket: manualToSend,
        duration,
      });

      setActiveGuicheSession(res.session);
      setNextTicketNumber(res.nextTicketNumber);
      setRemainingRecalls(res.remainingRecalls ?? 2);
      setManualTicketOpen(false);
      setManualTicketValue('');
      setPatientName('');
      setTicketNotes('');

      // Broadcast immediately to player screens & tabs
      if (res.call) {
        broadcastCallToPlayers(res.call);
      }

      // Play local sound preview if enabled
      if (playLocalSound && res.call) {
        setTimeout(() => {
          setIsPreviewingVoice(true);
          playCallAlert(res.call!.phrase, priorityFlag, {
            onSpeechEnd: () => setIsPreviewingVoice(false),
          });
        }, 80);
      }

      setLastCallDelivered(res.delivered);
      const nowStr = new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      setLastCallTime(nowStr);

      showToast('success', res.message);
      broadcastQueueUpdate();
    } catch (err: any) {
      showToast('error', err.message || 'Erro ao chamar próxima senha.');
    } finally {
      setIsCallingNext(false);
    }
  };

  // ----------------------------------------------------
  // GUICHÊ: RECHAMAR SENHA ATIVA (ATÉ 2 RECHAMADAS, MÁXIMO 3 CHAMADAS)
  // ----------------------------------------------------
  const handleRecallActiveTicket = async () => {
    if (!activeGuicheSession) {
      showToast('error', 'Nenhuma senha ativa neste guichê para rechamar.');
      return;
    }

    const targetPlayer = players.find((p) => p.id === selectedPlayerId) || players[0];
    const targetPlayerId = targetPlayer?.id || selectedPlayerId;

    unlockAudio();
    setIsRecalling(true);

    try {
      const res = await api.recallGuicheTicket({
        guiche_id: activeGuicheSession.guiche_id,
        playerId: targetPlayerId,
        duration,
      });

      if ((res as any).autoAdvanced) {
        setActiveGuicheSession(null);
        if ((res as any).nextTicketNumber) setNextTicketNumber((res as any).nextTicketNumber);
        showToast('info', res.message);
        broadcastQueueUpdate();
        return;
      }

      setActiveGuicheSession(res.session);
      setRemainingRecalls(res.remainingRecalls);

      if (res.call) {
        broadcastCallToPlayers(res.call);
      }

      if (playLocalSound && res.call) {
        setTimeout(() => {
          setIsPreviewingVoice(true);
          playCallAlert(res.call!.phrase, res.session.is_priority, {
            onSpeechEnd: () => setIsPreviewingVoice(false),
          });
        }, 80);
      }

      setLastCallDelivered(res.delivered);
      const nowStr = new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      setLastCallTime(nowStr);

      showToast('info', res.message);
      broadcastQueueUpdate();
    } catch (err: any) {
      showToast('error', err.message || 'Erro ao rechamar senha.');
    } finally {
      setIsRecalling(false);
    }
  };

  // ----------------------------------------------------
  // GUICHÊ: CLIENTE NÃO RESPONDEU -> SEGUIR PARA PRÓXIMA SENHA
  // ----------------------------------------------------
  const handleMarkTicketAbsent = async () => {
    if (!activeGuicheSession) return;
    const activeGuiche =
      guiches.find((g) => g.id === selectedGuicheId) ||
      (currentOperator?.profile === 'guiche' ? currentOperator : null) ||
      guiches[0];

    setIsMarkingAbsent(true);
    try {
      const res = await api.markGuicheTicketAbsent(activeGuiche?.id);
      setActiveGuicheSession(null);
      if (res.nextTicketNumber) setNextTicketNumber(res.nextTicketNumber);
      setPatientName('');
      setTicketNotes('');
      showToast('info', res.message);
      broadcastQueueUpdate();
    } catch (err: any) {
      showToast('error', err.message || 'Erro ao registrar ausência do cliente.');
    } finally {
      setIsMarkingAbsent(false);
    }
  };

  // ----------------------------------------------------
  // GUICHÊ: CONCLUIR ATENDIMENTO NO PRÓPRIO GUICHÊ (SEM CONSULTÓRIO)
  // ----------------------------------------------------
  const handleFinishAtGuiche = async () => {
    if (!activeGuicheSession) return;
    const activeGuiche =
      guiches.find((g) => g.id === selectedGuicheId) ||
      (currentOperator?.profile === 'guiche' ? currentOperator : null) ||
      guiches[0];

    try {
      const res = await api.finishGuicheTicket(activeGuiche?.id);
      setActiveGuicheSession(null);
      if (res.nextTicketNumber) setNextTicketNumber(res.nextTicketNumber);
      setPatientName('');
      setTicketNotes('');
      showToast('success', res.message);
      broadcastQueueUpdate();
    } catch (err: any) {
      showToast('error', err.message || 'Erro ao concluir atendimento.');
    }
  };

  // ----------------------------------------------------
  // GUICHÊ: ENCAMINHAR SENHA PARA O CONSULTÓRIO (ESPECIALIDADE)
  // ----------------------------------------------------
  const handleSendTicketToConsultorio = async (e: React.FormEvent) => {
    e.preventDefault();
    const ticketToForward = activeGuicheSession?.ticket_number || nextTicketNumber;
    if (!ticketToForward) {
      showToast('error', 'Nenhuma senha ativa para encaminhar.');
      return;
    }
    if (!targetConsultorioId) {
      showToast('error', 'Selecione o consultório e a especialidade de destino.');
      return;
    }

    const activeGuiche =
      guiches.find((g) => g.id === selectedGuicheId) ||
      (currentOperator?.profile === 'guiche' ? currentOperator : null) ||
      guiches[0];

    setIsSendingToConsultorio(true);
    try {
      const res = await api.sendTicketToConsultorio({
        ticket_number: ticketToForward,
        patient_name: patientName.trim() || undefined,
        is_priority: activeGuicheSession?.is_priority || isPriorityNext,
        consultorio_id: targetConsultorioId,
        guiche_id: activeGuiche?.id,
        guiche_name: activeGuiche?.name || 'Guichê 01',
        notes: ticketNotes.trim() || undefined,
      });

      showToast('success', res.message);

      // Libera a sessão ativa do guichê e prepara a próxima
      setActiveGuicheSession(null);
      if ((res as any).nextTicketNumber) {
        setNextTicketNumber((res as any).nextTicketNumber);
      }
      setPatientName('');
      setTicketNotes('');

      await loadData();
      broadcastQueueUpdate();
    } catch (err: any) {
      showToast('error', err.message || 'Erro ao encaminhar senha para o consultório.');
    } finally {
      setIsSendingToConsultorio(false);
    }
  };

  // ----------------------------------------------------
  // GUICHÊ: REINICIAR CONTADOR PARA 001
  // ----------------------------------------------------
  const handleResetCounter = async () => {
    if (!window.confirm('Deseja realmente reiniciar o contador sequencial de senhas de volta para 001 para todos os guichês?')) {
      return;
    }
    try {
      const res = await api.resetGuicheTicketCounter();
      setNextTicketNumber(res.nextTicketNumber);
      setActiveGuicheSession(null);
      showToast('success', res.message);
      broadcastQueueUpdate();
    } catch (err: any) {
      showToast('error', err.message || 'Erro ao reiniciar contador.');
    }
  };

  // ----------------------------------------------------
  // CONSULTÓRIO: CHAMAR PACIENTE DA FILA NA TV
  // ----------------------------------------------------
  const handleCallQueuedTicket = async (item: ConsultationQueueItem) => {
    const targetPlayer = players.find((p) => p.id === selectedPlayerId) || players[0];
    const targetPlayerId = targetPlayer?.id || selectedPlayerId;

    unlockAudio();
    setCallingQueueItemId(item.id);
    try {
      const res = await api.callQueuedTicket(item.id, {
        playerId: targetPlayerId,
        duration,
      });

      if (playLocalSound && res.call) {
        setTimeout(() => {
          setIsPreviewingVoice(true);
          playCallAlert(res.call!.phrase, Boolean(res.call!.is_priority), {
            onSpeechEnd: () => setIsPreviewingVoice(false),
          });
        }, 80);
      }

      showToast('success', res.message);
      await loadData();
      broadcastQueueUpdate();
    } catch (err: any) {
      showToast('error', err.message || 'Erro ao chamar paciente do consultório.');
    } finally {
      setCallingQueueItemId(null);
    }
  };

  const handleUpdateQueueStatus = async (
    itemId: string,
    status: 'waiting' | 'called' | 'completed' | 'cancelled'
  ) => {
    try {
      const res = await api.updateQueuedTicketStatus(itemId, status);
      showToast('info', res.message);
      await loadData();
      broadcastQueueUpdate();
    } catch (err: any) {
      showToast('error', err.message || 'Erro ao atualizar status da senha.');
    }
  };

  // Atalhos de Teclado no Guichê: [N] Normal, [P] Preferencial
  const callNextRef = useRef(handleCallNextTicket);
  useEffect(() => {
    callNextRef.current = handleCallNextTicket;
  });

  useEffect(() => {
    if (activeTab !== 'guiche') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) {
        return;
      }
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        callNextRef.current(false);
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        callNextRef.current(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeTab]);

  const selectedPlayer = players.find((p) => p.id === selectedPlayerId);
  const activeDiagnosticPlayer =
    players.find((p) => p.id === (diagnosticPlayerId || selectedPlayerId)) ||
    selectedPlayer ||
    players[0];

  const onlinePlayersCount = players.filter((p) => p.is_online).length;
  const offlinePlayersCount = players.length - onlinePlayersCount;

  const handleOpenDiagnosticForPlayer = (playerId: string) => {
    setSelectedPlayerId(playerId);
    setDiagnosticPlayerId(playerId);
    setActiveTab('diagnostic');
  };

  const getPlayerQuickElapsed = (lastSeen: string) => {
    if (!lastSeen) return 'Sem sinal';
    const diffSec = Math.floor((Date.now() - new Date(lastSeen).getTime()) / 1000);
    if (diffSec < 0) return 'Agora';
    if (diffSec < 60) return `${diffSec}s atrás`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m atrás`;
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h atrás`;
  };

  // Consultório Queue calculations
  const activeConsultorio =
    consultorios.find((c) => c.id === selectedConsultorioId) || consultorios[0] || null;

  const consultorioWaitingQueue = consultationQueue
    .filter((q) => (activeConsultorio ? q.consultorio_id === activeConsultorio.id : true) && q.status === 'waiting')
    .sort((a, b) => a.sequence - b.sequence);

  const consultorioCalledQueue = consultationQueue
    .filter((q) => (activeConsultorio ? q.consultorio_id === activeConsultorio.id : true) && q.status === 'called')
    .sort((a, b) => (b.called_at || b.updated_at).localeCompare(a.called_at || a.updated_at));

  const totalWaitingAllConsultorios = consultationQueue.filter((q) => q.status === 'waiting').length;

  const activeGuiche =
    guiches.find((g) => g.id === selectedGuicheId) ||
    (currentOperator?.profile === 'guiche' ? currentOperator : null) ||
    guiches[0];

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      {/* NAVEGAÇÃO DE PERFIS: GUICHÊ (TRIAGEM/ENCAMINHAMENTO) x CONSULTÓRIO (ESPECIALIDADE) x DIAGNÓSTICO */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-700 pb-4 mb-6">
        <div className="flex flex-wrap items-center gap-2 bg-slate-900/90 p-1.5 rounded-xl border border-slate-800">
          {/* ABA 1: PERFIL GUICHÊ */}
          <button
            type="button"
            id="tab-operator-guiche"
            onClick={() => setActiveTab('guiche')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider transition cursor-pointer ${
              activeTab === 'guiche'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-950/50'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            <UserCheck className="h-4 w-4" />
            <span>Perfil Guichê (Triagem)</span>
          </button>

          {/* ABA 2: PERFIL CONSULTÓRIO */}
          <button
            type="button"
            id="tab-operator-consultorio"
            onClick={() => setActiveTab('consultorio')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider transition cursor-pointer ${
              activeTab === 'consultorio'
                ? 'bg-cyan-600 text-white shadow-md shadow-cyan-950/50'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            <Stethoscope className="h-4 w-4" />
            <span>Perfil Consultório</span>
            {totalWaitingAllConsultorios > 0 && (
              <span className="ml-1 px-2 py-0.5 rounded-full bg-amber-500 text-slate-950 text-[10px] font-black">
                {totalWaitingAllConsultorios} na fila
              </span>
            )}
          </button>

          {/* ABA 3: DIAGNÓSTICO DOS PLAYERS */}
          <button
            type="button"
            id="tab-operator-diagnostic"
            onClick={() => setActiveTab('diagnostic')}
            className={`flex items-center gap-2 px-3.5 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider transition cursor-pointer ${
              activeTab === 'diagnostic'
                ? 'bg-blue-600 text-white shadow-md shadow-blue-900/40'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            <Activity className="h-4 w-4" />
            <span>Diagnóstico TV</span>
            {offlinePlayersCount > 0 && (
              <span className="ml-1 px-1.5 py-0.2 rounded-full bg-rose-500 text-white text-[9px] font-black animate-pulse">
                {offlinePlayersCount} off
              </span>
            )}
          </button>
        </div>

        {/* Botão de Atualização Rápida */}
        <div className="flex items-center gap-2 self-end md:self-auto">
          <button
            type="button"
            onClick={loadData}
            title="Atualizar fila dos consultórios e status dos players"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:text-white border border-slate-700 text-xs font-semibold cursor-pointer transition shadow-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Atualizar</span>
          </button>
        </div>
      </div>

      {/* BARRA DE SELEÇÃO DO PLAYER DESTINO */}
      {activeTab !== 'diagnostic' && (
        <div className="mb-6 space-y-3">
          {selectedPlayer && !selectedPlayer.is_online && (
            <div className="rounded-xl border border-rose-800/80 bg-rose-950/40 p-3 flex items-center justify-between gap-3 text-rose-200">
              <div className="flex items-center gap-2 text-xs">
                <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0" />
                <span>
                  O player <strong>{selectedPlayer.name} ({selectedPlayer.code})</strong> está sem sinal recente.
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleOpenDiagnosticForPlayer(selectedPlayer.id)}
                className="shrink-0 text-xs font-bold text-rose-300 hover:text-white underline flex items-center gap-1 cursor-pointer"
              >
                <span>Ver Diagnóstico</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <div className="rounded-xl border border-slate-700 bg-slate-800 p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2.5 flex-wrap gap-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                <Monitor className="h-4 w-4 text-blue-400" />
                <span>Painel / TV Destino da Chamada</span>
              </label>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    const next = !playLocalSound;
                    setPlayLocalSound(next);
                    try {
                      localStorage.setItem('indoor_op_local_sound', String(next));
                    } catch {}
                    if (next) {
                      unlockAudio();
                      showToast('info', 'Som ativado neste dispositivo ao disparar chamadas.');
                    } else {
                      stopCallAlert();
                      setIsPreviewingVoice(false);
                      showToast('info', 'Som silenciado neste dispositivo.');
                    }
                  }}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg border transition flex items-center gap-1 cursor-pointer ${
                    playLocalSound
                      ? 'bg-emerald-950/70 border-emerald-700/80 text-emerald-300 hover:bg-emerald-900/60'
                      : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {playLocalSound ? (
                    <Volume2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <VolumeX className="h-3.5 w-3.5 text-slate-400" />
                  )}
                  <span>{playLocalSound ? 'Som Local Ativo' : 'Som Local Mudo'}</span>
                </button>

                {selectedPlayer && (
                  <>
                    <a
                      href={`/?player=${encodeURIComponent(selectedPlayer.code)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-400 hover:text-blue-300 font-bold underline flex items-center gap-1 cursor-pointer"
                    >
                      Abrir TV ↗
                    </a>
                    {onOpenPlayerSimulation && (
                      <button
                        type="button"
                        onClick={() => onOpenPlayerSimulation(selectedPlayer.code)}
                        className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer hidden sm:inline"
                      >
                        (simular)
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {players.length === 0 ? (
              <p className="text-xs text-slate-400 py-2">
                Nenhum player cadastrado na sua empresa.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                {players.map((p) => {
                  const isSelected = p.id === selectedPlayerId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelectedPlayerId(p.id)}
                      className={`flex items-center justify-between p-3 rounded-xl border text-left transition cursor-pointer ${
                        isSelected
                          ? 'border-blue-500 bg-blue-950/50 ring-1 ring-blue-500 shadow-xs'
                          : 'border-slate-700/80 bg-slate-900/60 hover:bg-slate-900'
                      }`}
                    >
                      <div className="truncate pr-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-white text-xs truncate">{p.name}</span>
                          <span className="font-mono text-[9px] text-blue-400 bg-slate-950 px-1 py-0.2 rounded border border-slate-800 font-bold">
                            {p.code}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                          {p.location || 'Recepção'}
                        </p>
                      </div>

                      <span
                        className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
                          p.is_online
                            ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800'
                            : 'bg-rose-950/80 text-rose-300 border border-rose-800'
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            p.is_online ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'
                          }`}
                        />
                        {p.is_online ? 'Online' : 'Off'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* ABA 1: PERFIL GUICHÊ (SENHAS SEQUENCIAIS COMPARTILHADAS + ENCAMINHAMENTO)  */}
      {/* ========================================================================= */}
      {activeTab === 'guiche' && (
        <div className="space-y-6 animate-in fade-in duration-150">
          {/* CABEÇALHO DO GUICHÊ E INFORMATIVO DA SEQUÊNCIA COMPARTILHADA */}
          <div className="rounded-xl border border-emerald-800/60 bg-emerald-950/25 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                <UserCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded bg-emerald-500 text-slate-950">
                    PERFIL GUICHÊ
                  </span>
                  <h3 className="text-sm font-bold text-white">
                    {activeGuiche ? activeGuiche.name : 'Atendimento de Guichê'}
                  </h3>
                </div>
                <p className="text-xs text-slate-300 mt-0.5">
                  A sequência de senhas é <strong>compartilhada entre todos os guichês</strong>: ao chamar uma senha, o próximo guichê recebe automaticamente o número seguinte.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {guiches.length > 1 && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-400 font-semibold">Operando como:</span>
                  <select
                    value={selectedGuicheId}
                    onChange={(e) => setSelectedGuicheId(e.target.value)}
                    className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-bold text-white focus:border-emerald-500 focus:outline-none"
                  >
                    {guiches.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <button
                type="button"
                onClick={handleResetCounter}
                className="text-[10px] text-slate-400 hover:text-amber-300 border border-slate-700 bg-slate-900 hover:bg-slate-800 px-2.5 py-1.5 rounded-lg transition cursor-pointer"
                title="Reiniciar contador sequencial para 001"
              >
                Zerar p/ 001
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* COLUNA ESQUERDA (5 cols): PAINEL DE CHAMADA, RECHAMADA E CONTROLE DO GUICHÊ */}
            <div className="lg:col-span-5 space-y-4">
              <div className="rounded-2xl border border-slate-700 bg-slate-800 p-5 shadow-sm space-y-4">
                <div className="flex items-center justify-between border-b border-slate-700 pb-3">
                  <div className="flex items-center gap-2">
                    <div className={`p-1.5 rounded-lg ${activeGuicheSession ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
                      {activeGuicheSession ? <PhoneCall className="h-4 w-4" /> : <BellRing className="h-4 w-4" />}
                    </div>
                    <div>
                      <h4 className="text-xs font-black uppercase tracking-wider text-white">
                        Controle do {activeGuiche ? activeGuiche.name : 'Guichê'}
                      </h4>
                      <p className="text-[10px] text-slate-400">Fila centralizada e sequencial</p>
                    </div>
                  </div>

                  {activeGuicheSession ? (
                    <span className="text-[10px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-500 text-slate-950 flex items-center gap-1 shadow-sm">
                      <PhoneCall className="h-3 w-3" />
                      Em Atendimento ({activeGuicheSession.ticket_number})
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold text-emerald-400 bg-emerald-950/60 border border-emerald-500/40 px-2 py-0.5 rounded flex items-center gap-1">
                      <Check className="h-3 w-3" />
                      Guichê Livre
                    </span>
                  )}
                </div>

                {/* CARD DE SENHA ATIVA EM ATENDIMENTO */}
                {activeGuicheSession ? (
                  <div className="rounded-xl border-2 border-emerald-500/90 bg-gradient-to-b from-emerald-950/50 via-slate-900 to-slate-900 p-4 shadow-md space-y-3">
                    <div className="flex items-center justify-between border-b border-emerald-800/40 pb-2">
                      <span className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-400">
                        Senha em Atendimento no Guichê
                      </span>
                      <span className="text-xs font-mono font-black text-emerald-300">
                        Chamada {activeGuicheSession.call_count} de 3
                      </span>
                    </div>

                    <div className="text-center py-1">
                      <div className="flex items-center justify-center gap-2">
                        <span className="text-4xl sm:text-5xl font-mono font-black text-white tracking-tight drop-shadow-sm">
                          {activeGuicheSession.ticket_number}
                        </span>
                        {activeGuicheSession.is_priority && (
                          <span className="px-2 py-0.5 rounded bg-amber-500 text-slate-950 text-xs font-black uppercase shadow-sm">
                            PREF
                          </span>
                        )}
                      </div>
                      {activeGuicheSession.patient_name && (
                        <p className="text-xs font-semibold text-emerald-300 mt-1">
                          {activeGuicheSession.patient_name}
                        </p>
                      )}
                      <p className="text-[10px] text-slate-400 pt-1">
                        Última chamada às{' '}
                        {new Date(activeGuicheSession.last_call_at || activeGuicheSession.called_at).toLocaleTimeString('pt-BR', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </p>
                    </div>

                    {/* AÇÕES DE ENCERRAMENTO DO ATENDIMENTO DESTE GUICHÊ */}
                    <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800">
                      <button
                        type="button"
                        onClick={handleFinishAtGuiche}
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800 hover:bg-slate-700 py-2.5 px-3 text-xs font-bold text-slate-100 transition cursor-pointer shadow-xs"
                        title="Concluir atendimento direto no guichê (quando o cliente veio tirar dúvida ou pedir informação e não vai a consultório)"
                      >
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                        <span>Concluir (Balcão)</span>
                      </button>

                      <button
                        type="button"
                        disabled={isMarkingAbsent}
                        onClick={handleMarkTicketAbsent}
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-rose-700/80 bg-rose-950/60 hover:bg-rose-900/70 py-2.5 px-3 text-xs font-bold text-rose-300 transition cursor-pointer shadow-xs"
                        title="Cliente não respondeu às chamadas. Avançar para a próxima senha."
                      >
                        <UserX className="h-3.5 w-3.5" />
                        <span>Não Compareceu</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-3.5 text-center space-y-1">
                    <p className="text-xs font-bold text-slate-300">
                      Nenhuma senha em atendimento neste guichê.
                    </p>
                    <p className="text-[11px] text-slate-400">
                      Chame a próxima senha da fila abaixo para iniciar o atendimento.
                    </p>
                  </div>
                )}

                {/* BOTÃO DE RECHAMADA (SEMPRE DISPONÍVEL NA DASHBOARD!) */}
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Rechamada de Senha na TV
                  </label>
                  {activeGuicheSession ? (
                    <button
                      id="btn-recall-ticket"
                      type="button"
                      disabled={isRecalling || activeGuicheSession.call_count >= 3}
                      onClick={handleRecallActiveTicket}
                      className={`w-full flex items-center justify-between gap-2 rounded-xl py-3.5 px-4 text-xs font-black uppercase tracking-wider transition cursor-pointer shadow-md ${
                        activeGuicheSession.call_count >= 3
                          ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed opacity-60'
                          : 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-amber-950/50 ring-2 ring-amber-400/40'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <PhoneCall className={`h-4 w-4 ${activeGuicheSession.call_count < 3 ? 'animate-bounce' : ''}`} />
                        <span>
                          {activeGuicheSession.call_count >= 3
                            ? 'Limite de 3 chamadas atingido'
                            : isRecalling
                            ? 'Rechamando na TV...'
                            : `Rechamar Senha ${activeGuicheSession.ticket_number}`}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-slate-950/20">
                        {remainingRecalls > 0 ? `Restam ${remainingRecalls}x` : '0x'}
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="w-full flex items-center justify-between gap-2 rounded-xl py-3.5 px-4 text-xs font-bold uppercase tracking-wider bg-slate-800/60 text-slate-500 border border-slate-700/60 cursor-not-allowed opacity-50"
                      title="O botão de rechamada será habilitado assim que uma senha for chamada"
                    >
                      <div className="flex items-center gap-2">
                        <PhoneCall className="h-4 w-4 text-slate-600" />
                        <span>Rechamar Senha</span>
                      </div>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-500">
                        Aguardando chamada
                      </span>
                    </button>
                  )}
                </div>

                {/* SEÇÃO: CHAMAR PRÓXIMA SENHA SEQUENCIAL */}
                <div className="pt-3 border-t border-slate-700/80 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                      <BellRing className="h-4 w-4" />
                      <span>Chamar Próxima Senha da Fila</span>
                    </label>
                    <span className="text-[10px] font-bold text-slate-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-700">
                      Sincronizado
                    </span>
                  </div>

                  <div className="rounded-xl border border-slate-700/80 bg-slate-900/80 p-3 text-center space-y-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Próxima Senha Disponível na Empresa
                    </span>
                    <div className="flex items-center justify-center gap-2">
                      <span className="text-3xl sm:text-4xl font-mono font-black text-emerald-400 tracking-tight">
                        {isPriorityNext ? `P${nextTicketNumber}` : nextTicketNumber}
                      </span>
                      {isPriorityNext && (
                        <span className="px-2 py-0.5 rounded bg-amber-500 text-slate-950 text-xs font-black uppercase">
                          PREF
                        </span>
                      )}
                    </div>
                  </div>

                  {/* SELEÇÃO NORMAL X PREFERENCIAL */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={Boolean(activeGuicheSession)}
                      onClick={() => setIsPriorityNext(false)}
                      className={`py-2 px-3 rounded-lg border text-xs font-bold uppercase tracking-wider transition cursor-pointer ${
                        !isPriorityNext
                          ? 'bg-emerald-600 text-white border-emerald-500 shadow-sm'
                          : 'bg-slate-900 text-slate-400 border-slate-700 hover:text-white'
                      } ${activeGuicheSession ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      Senha Normal
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(activeGuicheSession)}
                      onClick={() => setIsPriorityNext(true)}
                      className={`py-2 px-3 rounded-lg border text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-1.5 transition cursor-pointer ${
                        isPriorityNext
                          ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-sm'
                          : 'bg-slate-900 text-slate-400 border-slate-700 hover:text-white'
                      } ${activeGuicheSession ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <Star className={`h-3.5 w-3.5 ${isPriorityNext ? 'fill-slate-950' : 'text-amber-400'}`} />
                      <span>Preferencial</span>
                    </button>
                  </div>

                  {/* BOTÃO PRINCIPAL: CHAMAR NA TV OU TRAVA DE SEGURANÇA SE EM ATENDIMENTO */}
                  {activeGuicheSession ? (
                    <div className="space-y-2">
                      <button
                        type="button"
                        disabled
                        className="w-full flex items-center justify-between gap-2 rounded-xl bg-slate-800 border border-slate-700 py-3.5 px-4 text-xs font-bold uppercase tracking-wider text-slate-500 cursor-not-allowed opacity-60"
                      >
                        <div className="flex items-center gap-2">
                          <BellRing className="h-4 w-4 text-slate-500" />
                          <span>Chamar Senha {isPriorityNext ? `P${nextTicketNumber}` : nextTicketNumber}</span>
                        </div>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 text-amber-400 border border-amber-500/30">
                          Guichê Ocupado
                        </span>
                      </button>
                      <p className="text-[11px] text-amber-300 bg-amber-950/40 border border-amber-800/60 rounded-xl p-2.5 text-center leading-relaxed">
                        ⚠️ <strong>Guichê atendendo a Senha {activeGuicheSession.ticket_number}</strong>. Para chamar a próxima senha ({nextTicketNumber}), realize o <strong>encaminhamento para o consultório</strong> ao lado ou clique em <strong>"Concluir (Balcão)"</strong>.
                      </p>
                    </div>
                  ) : (
                    <button
                      id="btn-call-next-ticket"
                      type="button"
                      disabled={isCallingNext || !selectedPlayerId}
                      onClick={() => handleCallNextTicket()}
                      className="w-full flex items-center justify-between gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 py-4 px-5 text-sm font-black uppercase tracking-wider text-white shadow-lg shadow-emerald-950/60 transition cursor-pointer disabled:opacity-50"
                    >
                      <div className="flex items-center gap-2">
                        <BellRing className="h-5 w-5" />
                        <span>
                          {isCallingNext
                            ? 'Chamando...'
                            : `Chamar Senha ${isPriorityNext ? `P${nextTicketNumber}` : nextTicketNumber}`}
                        </span>
                      </div>
                      <span className="bg-emerald-800/90 px-2 py-0.5 rounded text-[10px] font-mono">
                        {isPriorityNext ? 'Tecla P' : 'Tecla N'}
                      </span>
                    </button>
                  )}

                  {/* OPÇÃO DE INFORMAR SENHA AVULSA / MANUAL */}
                  {!activeGuicheSession && (
                    <div className="pt-2 border-t border-slate-700/80">
                      {!manualTicketOpen ? (
                        <button
                          type="button"
                          onClick={() => setManualTicketOpen(true)}
                          className="text-[11px] text-slate-400 hover:text-slate-200 underline cursor-pointer"
                        >
                          + Informar número de senha manual / avulso
                        </button>
                      ) : (
                        <div className="space-y-2 bg-slate-900 p-3 rounded-xl border border-slate-700">
                          <div className="flex items-center justify-between">
                            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
                              Número Manual da Senha
                            </label>
                            <button
                              type="button"
                              onClick={() => {
                                setManualTicketOpen(false);
                                setManualTicketValue('');
                              }}
                              className="text-slate-500 hover:text-slate-300"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <input
                            type="text"
                            value={manualTicketValue}
                            onChange={(e) => setManualTicketValue(e.target.value.toUpperCase())}
                            placeholder="Ex: 015 ou P008"
                            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-mono font-bold text-white focus:outline-none focus:border-emerald-500"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {lastCallDelivered !== null && (
                <div className="text-center text-[11px] font-medium text-emerald-400 flex items-center justify-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  <span>Última chamada enviada para a TV às {lastCallTime}</span>
                </div>
              )}
            </div>

            {/* COLUNA DIREITA (7 cols): DIRECIONAR SENHA PARA CONSULTÓRIO / ESPECIALIDADE */}
            <div className="lg:col-span-7 rounded-xl border border-cyan-500/40 bg-slate-800 p-5 shadow-lg space-y-4">
              <div className="border-b border-slate-700 pb-3">
                <label className="text-xs font-extrabold uppercase tracking-wider text-cyan-400 flex items-center gap-2">
                  <Stethoscope className="h-4 w-4" />
                  <span>2. Destinar Cliente ao Consultório (Por Especialidade)</span>
                </label>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Ao atender o cliente no guichê, direcione-o à especialidade que ele busca (ex: Ortopedista, Cardiologista, Pediatra). A senha entrará na fila exclusiva daquele consultório na sequência exata de envio.
                </p>
              </div>

              <form onSubmit={handleSendTicketToConsultorio} className="space-y-4">
                {/* Linha 1: Senha a encaminhar + Nome do Paciente */}
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                  <div className="sm:col-span-4">
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-300 mb-1">
                      Senha do Cliente
                    </label>
                    <div className="relative">
                      <Hash className="h-3.5 w-3.5 text-cyan-400 absolute left-3 top-3" />
                      <input
                        type="text"
                        readOnly
                        value={activeGuicheSession?.ticket_number || nextTicketNumber}
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 pl-8 pr-2.5 py-2 text-sm font-mono font-black uppercase text-white focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="sm:col-span-8">
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-300 mb-1">
                      Nome do Paciente / Cliente (Opcional)
                    </label>
                    <div className="relative">
                      <UserIcon className="h-3.5 w-3.5 text-slate-500 absolute left-3 top-3" />
                      <input
                        type="text"
                        value={patientName}
                        onChange={(e) => setPatientName(e.target.value)}
                        placeholder="Ex: Maria Fernandes"
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 pl-8 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>

                {/* Linha 2: Seleção do Consultório Cadastrado pela Empresa */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-300">
                      Escolha a Especialidade / Consultório de Destino *
                    </label>
                    <span className="text-[10px] text-slate-400">Cadastrados pela Empresa</span>
                  </div>

                  {consultorios.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-amber-800/80 bg-amber-950/20 p-4 text-center space-y-1 text-xs text-amber-200">
                      <ShieldAlert className="h-5 w-5 text-amber-400 mx-auto" />
                      <p className="font-bold">Nenhum consultório cadastrado pela Empresa.</p>
                      <p className="text-[11px] text-slate-400">
                        Os consultórios e especialidades são cadastrados pela Empresa na aba Operadores do Painel da Empresa.
                      </p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      {consultorios.map((cons) => {
                        const isSelected = cons.id === targetConsultorioId;
                        const waitingInThisConsultorio = consultationQueue.filter(
                          (q) => q.consultorio_id === cons.id && q.status === 'waiting'
                        ).length;

                        return (
                          <button
                            key={cons.id}
                            type="button"
                            onClick={() => setTargetConsultorioId(cons.id)}
                            className={`p-3 rounded-xl border text-left transition cursor-pointer flex flex-col justify-between ${
                              isSelected
                                ? 'border-cyan-400 bg-cyan-950/60 ring-2 ring-cyan-500/50 shadow-md'
                                : 'border-slate-700 bg-slate-900/70 hover:bg-slate-900'
                            }`}
                          >
                            <div>
                              <div className="flex items-center justify-between gap-1">
                                <span className="font-bold text-white text-xs truncate">
                                  {cons.name}
                                </span>
                                {isSelected && (
                                  <CheckCircle2 className="h-4 w-4 text-cyan-400 shrink-0" />
                                )}
                              </div>
                              <span className="mt-1 inline-block rounded bg-cyan-500/20 border border-cyan-500/40 px-2 py-0.5 text-[11px] font-extrabold text-cyan-300">
                                {cons.specialty || 'Clínico Geral'}
                              </span>
                            </div>

                            <div className="mt-2.5 pt-2 border-t border-slate-800 flex items-center justify-between text-[10px]">
                              <span className="text-slate-400">Fila atual:</span>
                              <span
                                className={`font-bold px-1.5 py-0.2 rounded ${
                                  waitingInThisConsultorio > 0
                                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                    : 'bg-slate-800 text-slate-400'
                                }`}
                              >
                                {waitingInThisConsultorio} aguardando
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Linha 3: Observação rápida e Botão de Envio */}
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                  <div className="sm:col-span-5">
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Observação para o Médico (Opcional)
                    </label>
                    <input
                      type="text"
                      value={ticketNotes}
                      onChange={(e) => setTicketNotes(e.target.value)}
                      placeholder="Ex: Retorno, Primeira consulta, Exames..."
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                    />
                  </div>

                  <div className="sm:col-span-7">
                    <button
                      id="btn-send-to-consultorio"
                      type="submit"
                      disabled={isSendingToConsultorio || !targetConsultorioId}
                      className="w-full flex items-center justify-center gap-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 py-3.5 px-4 text-xs font-black uppercase tracking-wider text-white shadow-lg shadow-cyan-950/60 transition cursor-pointer disabled:opacity-50"
                    >
                      <Send className="h-4 w-4" />
                      <span>
                        {isSendingToConsultorio
                          ? 'Encaminhando...'
                          : `Designar para ${
                              consultorios.find((c) => c.id === targetConsultorioId)?.name || 'Consultório'
                            } (${consultorios.find((c) => c.id === targetConsultorioId)?.specialty || 'Especialidade'})`}
                      </span>
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>

          {/* RESUMO DAS FILAS POR CONSULTÓRIO E ESPECIALIDADE (VISÃO DO GUICHÊ) */}
          <div className="rounded-xl border border-slate-700 bg-slate-800 p-5 shadow-sm space-y-4">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-white flex items-center gap-2">
                <Layers className="h-4 w-4 text-cyan-400" />
                <span>Sequência de Espera nos Consultórios (Ordem Exata de Envio)</span>
              </h4>
              <p className="text-[11px] text-slate-400">
                Cada consultório atende exclusivamente os pacientes encaminhados para a sua especialidade, na ordem em que foram enviados pelos guichês.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {consultorios.map((cons) => {
                const queueForCons = consultationQueue
                  .filter((q) => q.consultorio_id === cons.id && (q.status === 'waiting' || q.status === 'called'))
                  .sort((a, b) => a.sequence - b.sequence);

                return (
                  <div
                    key={cons.id}
                    className="rounded-xl border border-slate-700 bg-slate-900/70 p-4 flex flex-col justify-between space-y-3"
                  >
                    <div>
                      <div className="flex items-center justify-between border-b border-slate-800 pb-2.5 mb-3">
                        <div>
                          <span className="font-bold text-white text-sm block">{cons.name}</span>
                          <span className="text-xs font-extrabold text-cyan-400">
                            {cons.specialty || 'Clínico Geral'}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedConsultorioId(cons.id);
                            setActiveTab('consultorio');
                          }}
                          className="text-[10px] font-bold text-cyan-300 hover:text-white bg-cyan-950/60 border border-cyan-800/60 px-2 py-1 rounded-lg cursor-pointer transition"
                        >
                          Ver Consultório →
                        </button>
                      </div>

                      {queueForCons.length === 0 ? (
                        <p className="text-xs text-slate-500 py-4 text-center">
                          Nenhuma senha aguardando neste consultório.
                        </p>
                      ) : (
                        <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                          {queueForCons.map((item, index) => (
                            <div
                              key={item.id}
                              className={`rounded-lg border p-2.5 flex items-center justify-between gap-2 text-xs ${
                                item.status === 'called'
                                  ? 'border-emerald-500/60 bg-emerald-950/30'
                                  : 'border-slate-700/80 bg-slate-800/90'
                              }`}
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="px-1.5 py-0.2 rounded bg-slate-950 text-cyan-400 font-mono text-[10px] font-bold border border-slate-800">
                                    {index + 1}º
                                  </span>
                                  <span className="font-mono font-black text-white text-sm">
                                    {item.ticket_number}
                                  </span>
                                  {item.is_priority && (
                                    <span className="px-1.5 py-0.2 rounded bg-amber-500 text-slate-950 text-[9px] font-black uppercase">
                                      PREF
                                    </span>
                                  )}
                                  {item.status === 'called' && (
                                    <span className="px-1.5 py-0.2 rounded bg-emerald-500 text-slate-950 text-[9px] font-black uppercase">
                                      CHAMADO
                                    </span>
                                  )}
                                </div>
                                {item.patient_name && (
                                  <p className="text-[11px] text-slate-200 font-medium truncate mt-0.5">
                                    {item.patient_name}
                                  </p>
                                )}
                                {item.notes && (
                                  <p className="text-[10px] text-slate-400 truncate">
                                    Obs: {item.notes}
                                  </p>
                                )}
                              </div>

                              <button
                                type="button"
                                onClick={() => handleUpdateQueueStatus(item.id, 'cancelled')}
                                className="text-slate-500 hover:text-rose-400 p-1 rounded cursor-pointer"
                                title="Remover da fila"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* ABA 2: PERFIL CONSULTÓRIO (FILA SEQUENCIAL EXCLUSIVA POR ESPECIALIDADE)   */}
      {/* ========================================================================= */}
      {activeTab === 'consultorio' && (
        <div className="space-y-6 animate-in fade-in duration-150">
          {/* BARRA DE SELEÇÃO DO CONSULTÓRIO / ESPECIALIDADE ATIVA */}
          <div className="rounded-xl border border-cyan-800/60 bg-cyan-950/25 p-4 space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                <Stethoscope className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded bg-cyan-400 text-slate-950">
                    PERFIL CONSULTÓRIO
                  </span>
                  <h3 className="text-base font-extrabold text-white">
                    {activeConsultorio
                      ? `${activeConsultorio.name} — ${activeConsultorio.specialty || 'Clínico Geral'}`
                      : 'Painel do Consultório'}
                  </h3>
                </div>
                <p className="text-xs text-slate-300 mt-0.5">
                  As senhas abaixo foram triadas e encaminhadas pelo Guichê exclusivamente para esta especialidade, na sequência exata de chegada.
                </p>
              </div>
            </div>

            {/* Botões de Seleção de Consultório */}
            {consultorios.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2 border-t border-cyan-900/50">
                {consultorios.map((cons) => {
                  const isSelected = activeConsultorio?.id === cons.id;
                  const countWaiting = consultationQueue.filter(
                    (q) => q.consultorio_id === cons.id && q.status === 'waiting'
                  ).length;

                  return (
                    <button
                      key={cons.id}
                      type="button"
                      onClick={() => setSelectedConsultorioId(cons.id)}
                      className={`p-3 rounded-xl border text-left transition cursor-pointer flex items-center justify-between ${
                        isSelected
                          ? 'border-cyan-400 bg-cyan-900/50 ring-2 ring-cyan-400/50 shadow-md'
                          : 'border-slate-700 bg-slate-900/70 hover:bg-slate-900'
                      }`}
                    >
                      <div>
                        <p className="font-bold text-white text-xs">{cons.name}</p>
                        <p className="text-xs font-extrabold text-cyan-300 mt-0.5">
                          {cons.specialty || 'Clínico Geral'}
                        </p>
                      </div>
                      <span
                        className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase ${
                          countWaiting > 0
                            ? 'bg-amber-500 text-slate-950'
                            : 'bg-slate-800 text-slate-400 border border-slate-700'
                        }`}
                      >
                        {countWaiting} na fila
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* DESTAQUE: PRÓXIMA SENHA DA SEQUÊNCIA PARA CHAMAR AGORA */}
          {consultorioWaitingQueue.length > 0 && (
            <div className="rounded-2xl border-2 border-cyan-500/80 bg-gradient-to-r from-cyan-950/70 via-slate-900 to-slate-900 p-5 shadow-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-full bg-cyan-500 text-slate-950 text-[10px] font-black uppercase tracking-wider">
                    1º DA SEQUÊNCIA • PRÓXIMO PACIENTE
                  </span>
                  {consultorioWaitingQueue[0].is_priority && (
                    <span className="px-2.5 py-0.5 rounded-full bg-amber-500 text-slate-950 text-[10px] font-black uppercase tracking-wider flex items-center gap-1">
                      <Star className="h-3 w-3 fill-slate-950" />
                      PREFERENCIAL
                    </span>
                  )}
                </div>
                <div className="flex items-baseline gap-3 pt-1">
                  <span className="text-3xl sm:text-4xl font-mono font-black text-white tracking-tight">
                    SENHA {consultorioWaitingQueue[0].ticket_number}
                  </span>
                  {consultorioWaitingQueue[0].patient_name && (
                    <span className="text-lg font-bold text-cyan-300">
                      • {consultorioWaitingQueue[0].patient_name}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400">
                  Encaminhado por <strong>{consultorioWaitingQueue[0].guiche_name}</strong> para{' '}
                  <strong className="text-cyan-300">
                    {consultorioWaitingQueue[0].consultorio_name} ({consultorioWaitingQueue[0].specialty})
                  </strong>
                  {consultorioWaitingQueue[0].notes ? ` • Obs: "${consultorioWaitingQueue[0].notes}"` : ''}
                </p>
              </div>

              <button
                id="btn-call-next-consultorio"
                type="button"
                disabled={callingQueueItemId === consultorioWaitingQueue[0].id}
                onClick={() => handleCallQueuedTicket(consultorioWaitingQueue[0])}
                className="shrink-0 flex items-center justify-center gap-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black uppercase tracking-wider px-6 py-4 text-xs sm:text-sm shadow-lg shadow-cyan-500/25 transition cursor-pointer disabled:opacity-50"
              >
                <BellRing className="h-5 w-5 animate-bounce" />
                <span>
                  {callingQueueItemId === consultorioWaitingQueue[0].id
                    ? 'Chamando na TV...'
                    : `Chamar Senha ${consultorioWaitingQueue[0].ticket_number} na TV`}
                </span>
              </button>
            </div>
          )}

          {/* FILA SEQUENCIAL DE PACIENTES AGUARDANDO NO CONSULTÓRIO */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Coluna 1 (7 cols): Fila em Espera na Ordem de Envio */}
            <div className="lg:col-span-7 rounded-xl border border-slate-700 bg-slate-800 p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between border-b border-slate-700 pb-3">
                <div>
                  <h4 className="text-xs font-extrabold uppercase tracking-wider text-white flex items-center gap-2">
                    <Clock className="h-4 w-4 text-amber-400" />
                    <span>
                      Fila de Espera — {activeConsultorio?.name} ({activeConsultorio?.specialty})
                    </span>
                  </h4>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Senhas listadas na ordem sequencial exata enviada pelo Guichê.
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded-full bg-slate-900 border border-slate-700 text-xs font-bold text-cyan-300">
                  {consultorioWaitingQueue.length} aguardando
                </span>
              </div>

              {consultorioWaitingQueue.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 p-8 text-center space-y-2">
                  <Stethoscope className="h-8 w-8 text-slate-500 mx-auto" />
                  <p className="text-sm font-bold text-slate-300">
                    Nenhum paciente aguardando na fila deste consultório.
                  </p>
                  <p className="text-xs text-slate-400">
                    Assim que o Guichê designar uma senha para{' '}
                    <strong>{activeConsultorio?.name} ({activeConsultorio?.specialty})</strong>, ela aparecerá aqui na sequência.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {consultorioWaitingQueue.map((item, idx) => (
                    <div
                      key={item.id}
                      className={`rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition ${
                        idx === 0
                          ? 'border-cyan-500/60 bg-cyan-950/30'
                          : 'border-slate-700 bg-slate-900/70'
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-700 font-mono text-xs font-black text-cyan-400">
                            {idx + 1}º da Fila
                          </span>
                          <span className="text-lg font-mono font-black text-white">
                            SENHA {item.ticket_number}
                          </span>
                          {item.is_priority && (
                            <span className="px-2 py-0.5 rounded bg-amber-500 text-slate-950 text-[10px] font-black uppercase flex items-center gap-1">
                              <Star className="h-3 w-3 fill-slate-950" />
                              Preferencial
                            </span>
                          )}
                          <span className="px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800 text-[10px] font-bold">
                            {item.specialty}
                          </span>
                        </div>

                        {item.patient_name && (
                          <p className="text-sm font-bold text-slate-100">
                            Paciente: {item.patient_name}
                          </p>
                        )}

                        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                          <span>Enviado por: {item.guiche_name}</span>
                          <span>
                            Horário:{' '}
                            {new Date(item.created_at).toLocaleTimeString('pt-BR', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                          {item.notes && (
                            <span className="text-amber-300 font-medium">Obs: {item.notes}</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={callingQueueItemId === item.id}
                          onClick={() => handleCallQueuedTicket(item)}
                          className="flex items-center gap-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 px-3.5 py-2.5 text-xs font-extrabold uppercase tracking-wider text-white shadow-sm transition cursor-pointer disabled:opacity-50"
                        >
                          <BellRing className="h-3.5 w-3.5" />
                          <span>{callingQueueItemId === item.id ? 'Chamando...' : 'Chamar na TV'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleUpdateQueueStatus(item.id, 'completed')}
                          className="p-2.5 rounded-lg bg-slate-800 hover:bg-emerald-950/60 text-slate-300 hover:text-emerald-300 border border-slate-700 transition cursor-pointer"
                          title="Concluir atendimento"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Coluna 2 (5 cols): Em Atendimento / Chamados Recentemente pelo Consultório */}
            <div className="lg:col-span-5 rounded-xl border border-slate-700 bg-slate-800 p-5 shadow-sm space-y-4">
              <div className="border-b border-slate-700 pb-3">
                <h4 className="text-xs font-extrabold uppercase tracking-wider text-emerald-400 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Em Atendimento / Chamados na TV</span>
                </h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Pacientes já chamados por este consultório. Você pode rechamar na TV ou finalizar o atendimento.
                </p>
              </div>

              {consultorioCalledQueue.length === 0 ? (
                <p className="text-xs text-slate-400 py-6 text-center">
                  Nenhuma senha em atendimento no momento.
                </p>
              ) : (
                <div className="space-y-3">
                  {consultorioCalledQueue.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-emerald-700/60 bg-emerald-950/20 p-3.5 space-y-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-black text-base text-white">
                              SENHA {item.ticket_number}
                            </span>
                            {item.is_priority && (
                              <span className="px-1.5 py-0.2 rounded bg-amber-500 text-slate-950 text-[9px] font-black uppercase">
                                PREF
                              </span>
                            )}
                          </div>
                          {item.patient_name && (
                            <p className="text-xs font-bold text-emerald-200 mt-0.5">
                              {item.patient_name}
                            </p>
                          )}
                          <p className="text-[10px] text-slate-400 mt-0.5">
                            Chamado às{' '}
                            {item.called_at
                              ? new Date(item.called_at).toLocaleTimeString('pt-BR', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                })
                              : 'agora'}
                          </p>
                        </div>

                        <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold uppercase">
                          Em Atendimento
                        </span>
                      </div>

                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          disabled={callingQueueItemId === item.id}
                          onClick={() => handleCallQueuedTicket(item)}
                          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-700 border border-slate-700 py-2 px-3 text-xs font-bold text-cyan-300 transition cursor-pointer"
                        >
                          <BellRing className="h-3.5 w-3.5" />
                          <span>Rechamar na TV</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUpdateQueueStatus(item.id, 'completed')}
                          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 py-2 px-3 text-xs font-bold text-white transition cursor-pointer"
                        >
                          <Check className="h-3.5 w-3.5" />
                          <span>Concluir</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* ABA 3: DIAGNÓSTICO DOS PLAYERS (COMPLETO E ISOLADO)                       */}
      {/* ========================================================================= */}
      {activeTab === 'diagnostic' && (
        <div className="space-y-6 animate-in fade-in duration-150">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 rounded-xl border border-slate-700 bg-slate-800">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Total de Telas</span>
              <p className="text-xl font-black text-white mt-0.5">{players.length}</p>
            </div>
            <div className="p-3 rounded-xl border border-emerald-900/50 bg-emerald-950/20">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Online</span>
              <p className="text-xl font-black text-emerald-300 mt-0.5">{onlinePlayersCount}</p>
            </div>
            <div className="p-3 rounded-xl border border-rose-900/50 bg-rose-950/20">
              <span className="text-[10px] font-bold uppercase tracking-wider text-rose-400">Offline</span>
              <p className="text-xl font-black text-rose-300 mt-0.5">{offlinePlayersCount}</p>
            </div>
            <div className="p-3 rounded-xl border border-slate-700 bg-slate-800">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Intervalo Máx</span>
              <p className="text-xl font-black text-blue-400 mt-0.5">45s</p>
            </div>
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-800 p-4 shadow-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {players.map((p) => {
                const isSelected = p.id === activeDiagnosticPlayer?.id;
                const elapsed = getPlayerQuickElapsed(p.last_seen);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setDiagnosticPlayerId(p.id);
                      setSelectedPlayerId(p.id);
                    }}
                    className={`p-3.5 rounded-xl border text-left transition cursor-pointer flex items-center justify-between ${
                      isSelected
                        ? 'border-blue-500 bg-blue-950/50 ring-1 ring-blue-500'
                        : 'border-slate-700 bg-slate-900/60 hover:bg-slate-900'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-white text-sm">{p.name}</span>
                        <span className="font-mono text-[10px] text-blue-400 bg-slate-950 px-1 py-0.2 rounded border border-slate-800">
                          {p.code}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">{p.location || 'Sem localização'}</p>
                      <p className="text-[10px] text-slate-500 mt-1">Último sinal: {elapsed}</p>
                    </div>

                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                        p.is_online
                          ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800'
                          : 'bg-rose-950/80 text-rose-300 border border-rose-800'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          p.is_online ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'
                        }`}
                      />
                      {p.is_online ? 'Online' : 'Offline'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {activeDiagnosticPlayer && (
            <PlayerDiagnosticView
              player={activeDiagnosticPlayer}
              allPlayers={players}
              onSelectPlayer={(id) => {
                setDiagnosticPlayerId(id);
                setSelectedPlayerId(id);
              }}
              onRefresh={loadData}
              onOpenSimulation={onOpenPlayerSimulation}
              showToast={showToast}
            />
          )}
        </div>
      )}
    </div>
  );
};
