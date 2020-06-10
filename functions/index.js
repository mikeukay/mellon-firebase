const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp(functions.config().firebase);

const db = admin.firestore();

/* AUTH FUNCTIONS */
exports.onUserCreation = functions.auth.user().onCreate((user) => {
	const uid = user.uid;

	return db.collection('users').doc(uid).set({teams: {}, email: user.email});
});

exports.onUserDeletion = functions.auth.user().onDelete((user) => {
	const uid = user.uid;

	// TODO: also delete all of user's team entries
	return db.collection('users').doc(uid).delete();
});

/* HTTP Callable functions */
exports.ping = functions.https.onCall((data, context) => {
	return 'pong!';
});

exports.getUidFromEmail = functions.https.onCall((data, context) => {
	if (!context.auth) {
		 throw new functions.https.HttpsError('failed-precondition', 'You are not authenticated.');
	}

	if(!data) {
		throw new functions.https.HttpsError('invalid-argument', 'Please provide an email address.');
	}

	const email = data.email;

	if (!email || !(typeof email === 'string') || email.length === 0) {
		throw new functions.https.HttpsError('invalid-argument', 'What email is that?!');
	}

	return db.collection('users').where('email', '==', email).limit(1).get().then(snapshot => {
		if(snapshot.empty) {
			return '';
		}

		return snapshot.docs[0].id;
	});
});

/* Listens to changes on teams */
exports.onTeamChange = functions.firestore.document('teams/{teamId}').onWrite((change, context) => {
	const teamId = context.params.teamId;

 	const isDelete = !change.after.exists;
 	const isCreate = !change.before.exists;

	const teamName = isDelete ? '' : change.after.data().name;
	const teamDescription = isDelete ? '' : change.after.data().description;

	/* First, validate teamName and teamDescription */
	/* Delete/revert to previous version if rules aren't met */
	if(!isDelete) {
			if (	!teamName || 
			!(typeof teamName === 'string') || 
			teamName.length === 0 || 
			teamName.length > 32 || 
			teamName.includes("\n") ||
			!teamDescription || 
			!(typeof teamDescription === 'string') || 
			teamDescription.length === 0 || 
			teamDescription.length > 512) {

 				if(isCreate) {
 					return db.collection('teams').doc(teamId).delete();
 				}
 				return db.collection('teams').doc('teamId').set(change.before.data());

 			}
	}

	var modified = isCreate || (!isDelete && (teamName != change.before.data().name || teamDescription != change.before.data().description));

 	return db.runTransaction(t => {
 		var members;
 		if(isDelete) {
 			members = {};
 		} else {
 			members = change.after.data().members;
 		}

 		var prev_members;
 		if(isCreate) {
 			prev_members = {};
 		} else {
 			prev_members = change.before.data().members;
 		}

 		members_get_operations = [];

 		var member_count = 0;
 		for(const [key, value] of Object.entries(members)) {
 			if(member_count <= 100) {
 				members_get_operations.push(t.get(db.collection('users').doc(key)));
 			} else {
 				modified = true;
 			}
 			member_count += 1;
 		}

 		return Promise.all(members_get_operations).then((members_snaphsots) => {
 			members_uids = Object.keys(members);
 			prev_members_uids = Object.keys(prev_members);

 			var removed_members = prev_members_uids.filter(n => !members_uids.includes(n));

 			removed_members_get_operations = [];
 			for(var i = 0;i < removed_members.length; ++i) {
 				removed_members_get_operations.push(t.get(db.collection('users').doc(removed_members[i])));
 			}

 			return Promise.all(removed_members_get_operations).then((removed_members_snapshots) => {
 				to_wait = [];

 				var deleteTeamValue = {};
 				deleteTeamValue[teamId] = admin.firestore.FieldValue.delete();

 				for(var i = 0; i < removed_members_snapshots.length; ++i) {
 					var member_to_remove_from_team = removed_members_snapshots[i];
 					if(member_to_remove_from_team.exists) {
 						to_wait.push(t.set(member_to_remove_from_team.ref, {
 							teams: deleteTeamValue
 						}, { merge: true }));
 					}
 				}

 				for(var i = 0; i < members_snaphsots.length; ++i) {
 					var member_to_update = members_snaphsots[i];
 					if(!member_to_update.exists) {
 						delete members[member_to_update.id];
 						modified = true;
 					} else {
 						var updated_teams = member_to_update.data().teams;
 						updated_teams[teamId] = {'name': teamName, 'description': teamDescription};
 						if(updated_teams[teamId]['admin'] == null) {
 							updated_teams[teamId]['admin'] = members[member_to_update.id].admin;;
 						}
 						to_wait.push(t.update(member_to_update.ref, {
 							teams: updated_teams,
 						}));

 						if(members[member_to_update.id].email != member_to_update.data().email) {
 							var newMemberEntry =  {};
 							newMemberEntry['email'] = member_to_update.data().email;
 							newMemberEntry['admin'] = members[member_to_update.id].admin;
 							members[member_to_update.id] = newMemberEntry;
 							modified = true;
 						}
 					}
 				}

 				if(!isDelete && modified) {
 					t.set(db.collection('teams').doc(teamId), {
 						name: teamName,
 						description: teamDescription,
 						members: members
 					});
 				}

 				return Promise.all(to_wait);
 			});
 		});
 	});
});
