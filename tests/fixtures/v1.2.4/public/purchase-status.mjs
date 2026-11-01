export const isRejectedAttempt=o=>o.submissionFailure?.rejected===true;
export const isUnavailableTeam=o=>o.kind==='team'&&isRejectedAttempt(o)&&[404,410].includes(o.submissionFailure.httpStatus);
export const rejectedTeamTarget=(orders,id)=>orders.some(o=>o.packageId===id&&isUnavailableTeam(o));
