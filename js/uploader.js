// 1. Utilidades de Log
function logMsg(msg) {
    const log = document.getElementById('log');
    if (log) {
        const span = document.createElement('span');
        span.innerHTML = `<br>> ${msg}`;
        log.appendChild(span);
        log.scrollTop = log.scrollHeight;
    }
    console.log(msg);
}

// 2. Selección y Procesamiento Masivo
async function procesarSeleccionMultiple() {
    const mainFiles = document.getElementById('archivoPrincipal').files;
    const movesFiles = document.getElementById('archivoMovimientos').files;
    const log = document.getElementById('log');
    const pBar = document.getElementById('progressBar');
    const pContainer = document.getElementById('progressContainer');

    const temp = document.getElementById('temporadaInput').value;
    const cat = document.getElementById('categoriaInput').value;
    // Según tus instrucciones, valor por defecto para el combo
    const comp = document.getElementById('competicionInput').value || "2025/26 C.t. Pre-infantil Masculí - SF - Nivell B1 - 04";

    if (!temp || !cat || mainFiles.length === 0) {
        alert("⚠️ Rellena los datos maestros (Temporada y Categoría).");
        return;
    }

    log.innerHTML = "<b>[SISTEMA] Iniciando carga masiva...</b>";
    pContainer.style.display = 'block';

    for (let i = 0; i < mainFiles.length; i++) {
        const file = mainFiles[i];
        const percent = Math.round(((i + 1) / mainFiles.length) * 100);
        pBar.style.width = percent + '%';
        pBar.innerText = percent + '%';

        try {
            logMsg(`Analizando: ${file.name}`);
            
            // Extraer Jornada del nombre del fichero (ej: J1_P1...)
            const matchJornada = file.name.match(/J(\d+)/i);
            const numeroJornada = matchJornada ? parseInt(matchJornada[1]) : null;

            const mainJson = JSON.parse(await file.text());
            
            // Buscar movimientos por ID de partido
            const parts = file.name.split('_');
            const matchId = parts[1]; 
            const movesFile = Array.from(movesFiles).find(f => f.name.includes(matchId));
            const movesJson = movesFile ? JSON.parse(await movesFile.text()) : null;

            await importarPartido(mainJson, movesJson, temp, cat, comp, numeroJornada);
            logMsg(`✅ ${file.name} (Jornada ${numeroJornada}) procesado.`);
        } catch (error) {
            logMsg(`❌ Error crítico en ${file.name}: ${error.message}`);
            console.error(error);
        }
    }
    log.innerHTML += "<br><br><b>[FIN DEL PROCESO]</b>";
}

// 3. Función de Importación Core
async function importarPartido(mainJson, movesJson, tempNom, catNom, compNom, jornadaNum) {
    try {
        if (!mainJson.teams) throw new Error("JSON sin equipos");

        // --- MAESTROS ---
        // Temporada
        const { data: tData, error: tErr } = await supabaseClient.from('temporadas')
            .upsert({ nombre: tempNom }, { onConflict: 'nombre' }).select();
        if (tErr || !tData?.length) throw new Error(`Temporada: ${tErr?.message}`);
        const temporadaId = tData[0].id;

        // Categoría
        const { data: cData, error: cErr } = await supabaseClient.from('categorias')
            .upsert({ nombre: catNom }, { onConflict: 'nombre' }).select();
        if (cErr || !cData?.length) throw new Error(`Categoría: ${cErr?.message}`);
        const categoriaId = cData[0].id;

        // Competición
        const { data: compData, error: compErr } = await supabaseClient.from('competiciones').upsert({ 
            nombre: compNom, 
            temporada_id: temporadaId, 
            categoria_id: categoriaId 
        }, { onConflict: 'nombre,temporada_id,categoria_id' }).select();
        
        if (compErr || !compData?.length) throw new Error(`Competición: ${compErr?.message}`);
        const competicionId = compData[0].id;

        // --- EQUIPOS ---
        let idsEquipos = [];
        const mapaEquiposPorNombre = {}; 
        const mapaTeamIdANombre = {};

        for (const t of mainJson.teams) {
            const { data: clu, error: cluErr } = await supabaseClient.from('clubs')
                .upsert({ nombre: t.name, nombre_corto: t.shortName }, { onConflict: 'nombre' }).select();
            
            if (cluErr || !clu?.length) throw new Error(`Club ${t.name}: ${cluErr?.message}`);
            const clubId = clu[0].id;

            const { data: eq, error: eqErr } = await supabaseClient.from('equipos').upsert({
                club_id: clubId, 
                competicion_id: competicionId, 
                nombre_especifico: t.name, 
                team_id_intern_fce: String(t.teamIdIntern ?? t.idTeam ?? t.teamId ?? '')
            }, { onConflict: 'club_id,competicion_id' }).select();

            if (eqErr || !eq?.length) throw new Error(`Equipo ${t.name}: ${eqErr?.message}`);
            
            const eqId = eq[0].id;
            const teamIdKey = String(t.teamIdIntern ?? t.idTeam ?? t.teamId ?? '');
            
            idsEquipos.push(eqId);
            mapaEquiposPorNombre[t.name] = eqId;
            if (teamIdKey) mapaTeamIdANombre[teamIdKey] = t.name;
        }

        // --- PARTIDO ---
        const fechaValida = new Date(mainJson.time);
        const fechaISO = isNaN(fechaValida.getTime()) ? new Date().toISOString() : fechaValida.toISOString();

        const { data: partData, error: partErr } = await supabaseClient.from('partidos').upsert({
            id_match_extern: mainJson.idMatchExtern,
            id_match_intern: mainJson.idMatchIntern,
            competicion_id: competicionId,
            equipo_local_id: idsEquipos[0],
            equipo_visitante_id: idsEquipos[1],
            fecha_hora: fechaISO,
            puntos_local: mainJson.teams[0]?.players[0]?.teamScore || 0,
            puntos_visitante: mainJson.teams[0]?.players[0]?.oppScore || 0,
            jornada: jornadaNum
        }, { onConflict: 'id_match_extern' }).select();

        if (partErr || !partData?.length) throw new Error(`Partido: ${partErr?.message}`);
        const partidoId = partData[0].id;

        // --- LIMPIEZA DE DATOS PREVIOS (Evitar duplicados) ---
        logMsg(`Limpiando datos previos del partido ${partidoId}...`);
        
        // 1. Evolución del marcador
        await supabaseClient.from('partido_marcador_evolucion').delete().eq('partido_id', partidoId);
        
        // 2. Movimientos
        await supabaseClient.from('partido_movimientos').delete().eq('partido_id', partidoId);
        
        // 3. Tiros (necesitamos las IDs de estadísticas para borrar sus detalles)
        const { data: oldStats } = await supabaseClient.from('estadisticas_jugador_partido').select('id').eq('partido_id', partidoId);
        if (oldStats?.length) {
            const oldStatsIds = oldStats.map(s => s.id);
            await supabaseClient.from('detalle_tiros_jugador').delete().in('estadistica_id', oldStatsIds);
        }
        
        // 4. Estadísticas
        await supabaseClient.from('estadisticas_jugador_partido').delete().eq('partido_id', partidoId);

        // --- JUGADORES Y ESTADÍSTICAS ---
        const mapaJugadoresPorNombre = {}; 
        const mapaActorANombre = {};
        const movimientosIniciales = [];
        const nombresEnPista = new Set(); 

        for (const t of mainJson.teams) {
            const eqId = mapaEquiposPorNombre[t.name];
            
            for (const p of t.players) {
                const actorIdKey = String(p.actorId ?? p.idActor ?? p.actor_id ?? '');
                
                const { data: jug, error: jugErr } = await supabaseClient.from('jugadores').upsert({
                    nombre_completo: p.name, 
                    actor_id: actorIdKey
                }, { onConflict: 'nombre_completo' }).select();
                
                if (jugErr || !jug?.length) throw new Error(`Jugador ${p.name}: ${jugErr?.message}`);
                const jugadorId = jug[0].id;
                
                mapaJugadoresPorNombre[p.name] = jugadorId;
                if (actorIdKey) mapaActorANombre[actorIdKey] = p.name;

                await supabaseClient.from('plantillas').upsert({
                    jugador_id: jugadorId, equipo_id: eqId, dorsal: p.dorsal ? String(p.dorsal) : null
                }, { onConflict: 'jugador_id,equipo_id' });

                // Registrar titulares y crear su movimiento de entrada
                if (p.starting === true) {
                    nombresEnPista.add(p.name);
                    movimientosIniciales.push({
                        partido_id: partidoId,
                        periodo: 1,
                        minuto: 6,
                        segundo: 0,
                        tipo_movimiento: '112',
                        descripcion: 'Entra al camp',
                        jugador_id: jugadorId,
                        equipo_id: eqId,
                        marcador: '0-0',
                        event_uuid: `start_${partidoId}_${jugadorId}`
                    });
                }

                const d = p.data || {};
                const { data: statsData, error: statsErr } = await supabaseClient.from('estadisticas_jugador_partido').upsert({
                    partido_id: partidoId, 
                    jugador_id: jugadorId, 
                    dorsal: p.dorsal ? String(p.dorsal) : null,
                    puntos: d.score || 0, 
                    valoracion: d.valoration || 0,
                    tiempo_jugado: p.timePlayed || 0,
                    asistencias: d.assists || 0,
                    tapones: d.block || 0,
                    faltas_cometidas: d.faults || 0,
                    t1_anotados: d.shotsOfOneSuccessful || 0, 
                    t2_anotados: d.shotsOfTwoSuccessful || 0, 
                    t3_anotados: d.shotsOfThreeSuccessful || 0,
                    t1_intentados: d.shotsOfOneAttempted || 0, 
                    t2_intentados: d.shotsOfTwoAttempted || 0, 
                    t3_intentados: d.shotsOfThreeAttempted || 0
                }, { onConflict: 'partido_id,jugador_id' }).select();

                if (statsData?.length && d) { 
                    await guardarDetalleTiros(d, statsData[0].id); 
                }
            }
        }

        // --- MARCADOR Y MOVIMIENTOS ---
        if (mainJson.score?.length) {
            const evolData = mainJson.score.map(s => ({
                partido_id: partidoId, periodo: s.period || 0, minuto_cuarto: s.minuteQuarter || 0,
                minuto_absoluto: s.minuteAbsolute || 0, puntos_local: s.local || 0,
                puntos_visitante: s.visit || 0, diferencia: (s.local || 0) - (s.visit || 0)
            }));
            await supabaseClient.from('partido_marcador_evolucion').insert(evolData);
        }

        const rawMoves = Array.isArray(movesJson) ? movesJson : (movesJson?.moves || []);
        let dataMoves = [];
        
        if (rawMoves.length > 0) {
            dataMoves = rawMoves.map(m => {
                const actorIdKey = m.actorId ? String(m.actorId) : null;
                const teamIdKey = m.idTeam ? String(m.idTeam) : null;
                
                const nombreJugador = actorIdKey ? mapaActorANombre[actorIdKey] : null;
                const nombreEquipo = teamIdKey ? mapaTeamIdANombre[teamIdKey] : null;
                
                const jugadorId = nombreJugador ? mapaJugadoresPorNombre[nombreJugador] : null;
                const equipoId = nombreEquipo ? mapaEquiposPorNombre[nombreEquipo] : null;

                const tipoMov = String(m.idMove ?? m.id_move ?? 'EVENTO');
                
                // Actualizar estado de jugadores en pista según los movimientos
                if (nombreJugador) {
                    if (tipoMov === '112') {
                        nombresEnPista.add(nombreJugador);
                    } else if (tipoMov === '115') {
                        nombresEnPista.delete(nombreJugador);
                    }
                }

                return {
                    partido_id: partidoId,
                    periodo: m.period ?? m.periodo ?? 0,
                    minuto: m.min ?? m.minuto ?? 0,
                    segundo: m.second ?? m.sec ?? m.segundo ?? 0,
                    tipo_movimiento: tipoMov,
                    descripcion: m.move ?? m.descripcion ?? '',
                    jugador_id: jugadorId,
                    equipo_id: equipoId,
                    marcador: m.score ?? m.marcador ?? '',
                    event_uuid: m.event_uuid ?? m.eventUuid ?? `move_${partidoId}_${Math.random().toString(36).substr(2, 9)}`
                };
            });
        }

        // Generar movimientos de salida para los jugadores que quedaron en pista
        // Obtener el marcador final para los movimientos de salida
        let marcadorFinal = `${mainJson.teams[0]?.players[0]?.teamScore || 0}-${mainJson.teams[0]?.players[0]?.oppScore || 0}`;
        
        // Intentar obtener el marcador del evento 116 (Fin de periodo/partido) del último periodo disponible
        const endOfMatchMove = [...dataMoves]
            .filter(m => m.tipo_movimiento === '116')
            .sort((a, b) => {
                if (b.periodo !== a.periodo) return b.periodo - a.periodo;
                if (b.minuto !== a.minuto) return b.minuto - a.minuto;
                return b.segundo - a.segundo;
            })[0];

        if (endOfMatchMove && endOfMatchMove.marcador) {
            marcadorFinal = endOfMatchMove.marcador;
        } else if (mainJson.score && mainJson.score.length > 0) {
            const lastScore = mainJson.score[mainJson.score.length - 1];
            marcadorFinal = `${lastScore.local}-${lastScore.visit}`;
        }

        const movimientosFinales = [];
        for (const nombre of nombresEnPista) {
            const jugadorId = mapaJugadoresPorNombre[nombre];
            let eqId = null;
            
            // Buscar a qué equipo pertenece este jugador por su nombre
            for (const t of mainJson.teams) {
                if (t.players.some(p => p.name === nombre)) {
                    eqId = mapaEquiposPorNombre[t.name];
                    break;
                }
            }

            if (jugadorId && eqId) {
                movimientosFinales.push({
                    partido_id: partidoId,
                    periodo: 8,
                    minuto: 0,
                    segundo: 0,
                    tipo_movimiento: '115',
                    descripcion: 'Surt del camp',
                    jugador_id: jugadorId,
                    equipo_id: eqId,
                    marcador: marcadorFinal, 
                    event_uuid: `end_${partidoId}_${jugadorId}`
                });
            }
        }

        // Unir todos los movimientos: iniciales + transcurso + finales
        dataMoves = [...movimientosIniciales, ...dataMoves, ...movimientosFinales];

        if (dataMoves.length > 0) {
            await supabaseClient.from('partido_movimientos').upsert(dataMoves, { onConflict: 'event_uuid' });
        }
        return true;
    } catch (err) {
        throw err;
    }
}

// 4. Detalle de Tiros (Heatmap)
async function guardarDetalleTiros(dataObj, estadisticaId) {
    const tiros = [];
    const config = [
        { key: 'metadataShotsOfOneSuccessful', tipo: '1pt' }, { key: 'metadataShotsOfOneFailed', tipo: '1pt' },
        { key: 'shootingOfTwoSuccessfulPoint', tipo: '2pt' }, { key: 'shootingOfTwoFailedPoint', tipo: '2pt' },
        { key: 'shootingOfThreeSuccessfulPoint', tipo: '3pt' }, { key: 'shootingOfThreeFailedPoint', tipo: '3pt' }
    ];

    config.forEach(cfg => {
        const lista = dataObj[cfg.key];
        if (Array.isArray(lista)) {
            lista.forEach(t => {
                tiros.push({
                    estadistica_id: estadisticaId,
                    tipo_tiro: cfg.tipo,
                    periodo: t.period || 0,
                    minuto: t.minute !== undefined ? t.minute : (t.min || 0),
                    segundo: t.second || 0,
                    x: t.x || 0,
                    y: t.y || 0,
                    x_norm: t.xnormalize || 0,
                    y_norm: t.ynormalize || 0,
                    event_uuid: t.event_uuid || t.eventUuid || null
                });
            });
        }
    });

    if (tiros.length > 0) {
        await supabaseClient.from('detalle_tiros_jugador').upsert(tiros, { onConflict: 'event_uuid' });
    }
}
