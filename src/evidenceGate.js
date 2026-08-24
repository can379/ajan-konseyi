export class EvidenceGateError extends Error {
  constructor(action,reasons){super(`EvidenceGate ${action} işlemini engelledi: ${reasons.join("; ")}`);this.name="EvidenceGateError";this.action=action;this.reasons=reasons;}
}

function latestTest(tests,command){return [...(tests||[])].reverse().find((item)=>String(item.command||"").trim()===command);}

export function evaluateEvidenceGate(run,action,{requireTests=action!=="merge"}={}) {
  const reasons=[],tasks=(run.tasks||[]).filter((task)=>task.status==="done");
  // Bir analiz/tartışma koşusunun çıktısı bir rapordur. Bağımsız incelemede
  // bulunan itirazlar bu raporun parçasıdır; raporun tamamlanmasını değil,
  // değişikliğin merge/publish edilmesini engellemelidir. Kod koşularında ise
  // `done` dahil bütün kapılar aynı katılıkta kalır.
  const reportCompletion=action==="done"&&run.mode!=="code";
  if(!tasks.length) reasons.push("Tamamlanmış görev ve TaskContract bulunmuyor");
  for(const task of tasks){
    const contract=task.contract;
    if(!contract||contract.status!=="ready"){reasons.push(`[${task.id}] TaskContract hazır değil`);continue;}
    const reviews=(run.reviews||[]).filter((review)=>review.taskId===task.id&&!review.invalidatedAt);
    if(!reviews.length){reasons.push(`[${task.id}] bağımsız review bulunmuyor`);continue;}
    // Rapor koşusunda aktif ve sözleşmeyle eşleşen immutable review yeterlidir;
    // puan/önem sonuçları nihai rapora taşınır. Kod kapılarında 4/5 ve yüksek
    // olmayan önem şartı korunur.
    const passing=reviews.find((review)=>(reportCompletion||Number(review.agreement)>=4)&&(reportCompletion||review.severity!=="yuksek")&&review.evidencePacket&&review.reviewedCommit&&review.reviewedTree&&review.contractFingerprint===contract.fingerprint);
    if(!passing) reasons.push(`[${task.id}] review geçmedi veya kanıt paketi sözleşmeyle eşleşmiyor`);
  }
  const requiredCommands=requireTests?[...new Set([...tasks.flatMap((task)=>task.contract?.testCommands||[]),...(run.testCommand?[String(run.testCommand).trim()]:[])].filter(Boolean))]:[];
  for(const command of requiredCommands){const result=latestTest(run.tests,command);if(!result)reasons.push(`Zorunlu test çalıştırılmadı: ${command}`);else if(result.ok!==true)reasons.push(`Zorunlu test başarısız: ${command}`);}
  // Riskli bir doğrulama sonucu geçerli bir rapor çıktısıdır. `curutuldu`
  // raporu da kapatır; merge/publish ve bütün kod koşuları katı kalır.
  if(run.verify&&run.verify.verdict!=="saglam"&&(!reportCompletion||!["riskli","uyari"].includes(run.verify.verdict)))reasons.push(`Doğrulayıcı turu geçmedi: ${run.verify.verdict}`);
  return {action,passed:reasons.length===0,reasons,checkedAt:new Date().toISOString(),requiredCommands,
    evidence:{tasks:tasks.map((task)=>task.id),reviews:(run.reviews||[]).map((review)=>review.evidencePacket).filter(Boolean),tests:requiredCommands}};
}

export function assertEvidenceGate(run,action,options){const result=evaluateEvidenceGate(run,action,options);run.evidenceGate=result;if(!result.passed)throw new EvidenceGateError(action,result.reasons);return result;}
