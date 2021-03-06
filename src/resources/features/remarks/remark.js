import {inject} from 'aurelia-framework';
import {Router} from 'aurelia-router';
import {I18N} from 'aurelia-i18n';
import TranslationService from 'resources/services/translation-service';
import LocationService from 'resources/services/location-service';
import FiltersService from 'resources/services/filters-service';
import RemarkService from 'resources/services/remark-service';
import ToastService from 'resources/services/toast-service';
import LoaderService from 'resources/services/loader-service';
import AuthService from 'resources/services/auth-service';
import UserService from 'resources/services/user-service';
import CriteriaService from 'resources/services/criteria-service';
import ReportService from 'resources/services/report-service';
import SignalRService from 'resources/services/signalr-service';
import OperationService from 'resources/services/operation-service';
import LogService from 'resources/services/log-service';
import {EventAggregator} from 'aurelia-event-aggregator';
import Environment from '../../../environment';

@inject(Router, I18N, TranslationService,
LocationService, FiltersService, RemarkService,
ToastService, LoaderService, AuthService, UserService,
CriteriaService, ReportService, SignalRService, OperationService, 
EventAggregator, LogService, Environment)
export class Remark {
  newImageResized = null;

  constructor(router, i18n, translationService, location, filtersService, remarkService,
  toastService, loader, authService, userService, criteriaService, reportService,
  websockets, operationService, eventAggregator, logService, environment) {
    this.router = router;
    this.i18n = i18n;
    this.translationService = translationService;
    this.location = location;
    this.filtersService = filtersService;
    this.remarkService = remarkService;
    this.toast = toastService;
    this.loader = loader;
    this.authService = authService;
    this.userService = userService;
    this.criteriaService = criteriaService;
    this.reportService = reportService;
    this.websockets = websockets;
    this.operationService = operationService;
    this.eventAggregator = eventAggregator;
    this.log = logService;
    this.feature = environment.feature;
    this.remarkPhotosLimit = environment.constraints.remarkPhotosLimit * 3; //3 different sizes.
    this.remark = {};
    this.sending = false;
    this.isInRange = false;
    this.photoToDelete = null;
    this.isPositiveVote = false;
    this.visiblePhotoIndex = 0;
    this.processDescription = '';
    this.cancelDescription = '';
    this.websockets.initialize();
  }

  get isAuthor() {
    return this.isAuthenticated && this.account.userId === this.remark.author.userId;
  }

  get canDelete() {
    return this.isAuthor || 
      this.userService.canModerate(this.account) ||
      this.criteriaService.canDeleteRemark(this.remark, this.account.userId);
  }

  get canResolve() {
    return (this.remark.resolved === false && this.state !== 'canceled')
      && (this.feature.resolveRemarkLocationRequired === false || this.isInRange)
      && (this.userService.canModerate(this.account) || 
          this.criteriaService.canResolveRemark(this.remark, this.account.userId));
  }

  get canCancel() {
    return (this.remark.resolved === false && this.state !== 'canceled')
      && (this.criteriaService.canCancelRemark(this.remark, this.account.userId));
  }

  get canRenew() {
    return this.remark.resolved;
  }

  get canAddPhotos() {
    return this.remark.resolved === false && this.remark.photos.length < this.remarkPhotosLimit;
  }

  get canReport() {
    return this.isAuthenticated;
  }

  get canDeletePhotos() {
    return this.isAuthor || this.userService.canModerate(this.account);
  }

  get canVoteNegatively() {
    return this.canVote && (this.hasVotedPositively || !this.hasVoted);
  }

  get canVotePositively() {
    return this.canVote && (this.hasVotedNegatively || !this.hasVoted);
  }

  get canVote() {
    return this.isAuthenticated && !this.remark.resolved;
  }

  get hasVotedPositively() {
    return this.hasVoted && this.vote.positive;
  }

  get hasVotedNegatively() {
    return this.hasVoted && !this.vote.positive;
  }

  get hasVoted() {
    return this.vote !== null && typeof this.vote !== 'undefined';
  }

  get canTakeAction() {
    return this.isAuthenticated && !this.isParticipant && !this.remark.resolved;
  }

  get canProcess() {
    return !this.remark.resolved && this.state !== 'canceled';
  }

  get isParticipant() {
    return this.remark.participants.find(x => x.user.userId === this.account.userId);
  }

  get isActionDescriptionValid() {
    return this._isDescriptionValid(this.actionDescription);
  }

  get isProcessDescriptionValid() {
    return this._isDescriptionValid(this.processDescription);
  }

  get isCancelDescriptionValid() {
    return this._isDescriptionValid(this.cancelDescription);
  }

  _isDescriptionValid(description) {
    return description !== null &&
      description.match(/^ *$/) === null &&
      description.length <= 2000 &&
      description.length >= 3
  }

  async activate(params, routeConfig) {
    this.location.startUpdating();
    this.id = params.id;
    this.account = {userId: ''};
    this.isAuthenticated = this.authService.isLoggedIn;
    if (this.isAuthenticated) {
      this.account = await this.userService.getAccount();
    }
    await this.loadRemark();

    this.log.trace('remark_details_activated', {
      remark: this.remark,
      filters: this.filtersService.filters
    });
  }

  async attached() {
    let that = this;
    this.setupFileInput();
    this.setupCameraInput();
    this.scrollToTop();
    this.remarkResolvedSubscription = await this.subscribeRemarkResolved();
    this.remarkDeletedSubscription = await this.subscribeRemarkDeleted();
    this.remarkVoteSubmittedSubscription = await this.subscribeRemarkVoteSubmitted();
    this.remarkVoteDeletedSubscription = await this.subscribeRemarkVoteDeleted();

    this.operationService.subscribe('resolve_remark',
      operation => this.handleRemarkResolved(operation),
      operation => this.handleRejectedOperation(operation));

    this.operationService.subscribe('delete_remark',
      operation => this.handleRemarkDeleted(operation),
      operation => this.handleRejectedOperation(operation));

      this.operationService.subscribe('cancel_remark',
      operation => this.handleRemarkCanceled(operation),
      operation => this.handleRejectedOperation(operation));

    this.operationService.subscribe('add_photos_to_remark',
      async operation => await this.handlePhotosAddedToRemark(operation),
      operation => this.handleRejectedOperation(operation));

    this.operationService.subscribe('remove_photos_from_remark',
      async operation => await this.handlePhotosFromRemarkRemoved(operation),
      async operation => await this.handleRemovePhotosFromRemarkRejected(operation));

    this.operationService.subscribe('submit_remark_vote',
      operation => this.handleRemarkVoteSubmitted(operation),
      operation => this.handleRejectedOperation(operation));

    this.operationService.subscribe('delete_remark_vote',
      operation => this.handleRemarkVoteDeleted(operation),
      operation => this.handleRejectedOperation(operation));

    this.operationService.subscribe('process_remark',
      operation => this.handleRemarkProcessed(operation),
      operation => this.handleRejectedOperation(operation));

    this.operationService.subscribe('renew_remark',
      operation => this.handleRemarkRenewed(operation),
      operation => this.handleRejectedOperation(operation));

    this.operationService.subscribe('report_remark',
      operation => this.handleRemarkReported(operation),
      operation => this.handleRejectedOperation(operation));

    this.newImageResized = async (base64) => {
      if (base64 === '') {
        return;
      }
      await that.addPhotos(base64);
    };

    this.log.trace('remark_details_attached');
  }

  detached() {
    this.remarkResolvedSubscription.dispose();
    this.remarkDeletedSubscription.dispose();
    this.remarkVoteSubmittedSubscription.dispose();
    this.remarkVoteDeletedSubscription.dispose();
    this.operationService.unsubscribeAll();
  }

  setupCameraInput() {
    this.cameraInput = document.getElementById('camera-input');
    $('#camera-input').change(async () => {
      this.newImage = this.files[0];
    });
  }

  setupFileInput() {
    this.fileInput = document.getElementById('file-input');
    $('#file-input').change(async () => {
      this.newImage = this.files[0];
    });
  }

  async loadRemark() {
    let remark = await this.remarkService.getRemark(this.id);
    this.remark = remark;
    this.remark.categoryName = this.translationService.tr(`remark.category_${this.remark.category.name}`);
    this.processPhotos(remark);
    this.state = remark.state.state;
    this.stateName = this.translationService.tr(`remark.state_${this.state}`);
    this.latitude = remark.location.coordinates[1];
    this.longitude = remark.location.coordinates[0];
    this.isInRange = this.location.isInRange({
      latitude: this.latitude,
      longitude: this.longitude
    });
    this.remark.address = remark.location.address;
    if (remark.tags === null) {
      remark.tags = [];
    }
    if (remark.comments === null) {
      remark.comments = [];
    }
    if (remark.participants === null) {
      remark.participants = [];
    }
    this.tags = remark.tags.map(tag => {
      return {
        key: tag,
        value: this.translationService.tr(`tags.${tag}`)
      };
    });
    this.rating = remark.rating;
    if (remark.votes === null) {
      remark.votes = [];
    }
    this._calculateVotes();
    this.activitiesCount = this.remark.states.length - 1;

    let latestCommentIndex = remark.comments
      .map(x => x.removed)
      .lastIndexOf(false);

    if (latestCommentIndex > -1) {
      this.latestComment = remark.comments[latestCommentIndex];
    }

    let latestActivity = {description: ''};
    let latestActivityIndex = this.remark.states
      .map(x => x.removed)
      .lastIndexOf(false);

    if (latestActivityIndex > 0) {
      latestActivity = this.remark.states[latestActivityIndex];
      this._setLatestActivity(latestActivity.description);
    }
  }

  _calculateVotes() {
    this.positiveVotes = 0;
    this.negativeVotes = 0;
    this.remark.votes.forEach(x => {
        if (x.positive) {
          this.positiveVotes++;
        } else {
          this.negativeVotes++;
        }
      })
    this.vote = this.remark.votes.find(x => x.userId === this.account.userId);
  }

  _setLatestActivity(description) {
    if (description === '') {
      description = this.translationService.tr('remark.activity_has_no_description');
    }
    this.latestActivity = {description};
  }

  processPhotos(remark) {
    let smallPhotos = remark.photos.filter(x => x.size === 'small');
    let mediumPhotos = remark.photos.filter(x => x.size === 'medium');
    let bigPhotos = remark.photos.filter(x => x.size === 'big');
    this.remark.photos = smallPhotos.map((photo, index) => {
      return {
        groupId: photo.groupId,
        visible: index === 0,
        small: photo.url,
        medium: mediumPhotos[index].url,
        big: bigPhotos[index].url,
        user: photo.user
      };
    });
  }

  display() {
    this.filtersService.setCenter({latitude: this.latitude, longitude: this.longitude});
    this.filtersService.setMapEnabled(true);
    this.router.navigateToRoute('display-remark', {id: this.id});
  }

  displayCamera() {
    this.cameraInput.click();
  }

  browseGallery() {
    this.fileInput.click();
  }

  async delete() {
    if (this.canDelete === false) {
      await this.toast.error(this.translationService.tr('remark.not_allowed_to_delete'));

      return;
    }
    this.sending = true;
    this.loader.display();
    this.toast.info(this.translationService.tr('remark.deleting_remark'));
    await this.remarkService.deleteRemark(this.id);
  }

  async cancel() {
    this.sending = true;
    this.loader.display();
    this.toast.info(this.translationService.tr('remark.canceling_remark'));
    await this.remarkService.cancelRemark(this.id, this.cancelDescription);
  }

  async resolve() {
    let command = {
      remarkId: this.remark.id,
      latitude: this.location.current.latitude,
      longitude: this.location.current.longitude,
      address: this.location.current.address
    };
    this.sending = true;
    this.loader.display();
    this.toast.info(this.translationService.tr('remark.resolving_remark'));
    await this.remarkService.resolveRemark(command);
  }

  async report() {
    this.loader.display();
    this.sending = true;
    await this.reportService.reportRemark(this.id);
  }

  async renew() {
    let command = {
      remarkId: this.remark.id,
      latitude: this.location.current.latitude,
      longitude: this.location.current.longitude,
      address: this.location.current.address
    };
    this.sending = true;
    this.loader.display();
    this.toast.info(this.translationService.tr('remark.renewing_remark'));
    await this.remarkService.renewRemark(command);
  }

  async addPhotos(base64Image) {
    this.remark.status = 'processing_photos';
    this.sending = true;
    this.toast.info(this.translationService.tr('remark.adding_photo'));
    let reader = new FileReader();
    let file = this.newImage;
    reader.onload = async () => {
      if (file.type.indexOf('image') < 0) {
        this.toast.error(this.translationService.trCode('invalid_file'));
        this.loader.hide();
        this.sending = false;

        return;
      }
      let photo = {
        base64: base64Image,
        name: file.name,
        contentType: file.type
      };

      let photos = {
        photos: [photo]
      };

      await this.remarkService.addPhotos(this.remark.id, photos);
      await this.toast.success(this.translationService.tr('remark.processing_photo'), 6000);
    };
    reader.readAsDataURL(file);
  }

  markPhotoToDelete(photo) {
    this.photoToDelete = photo;
  }

  async deletePhoto() {
    if (this.photoToDelete === null) {
      return;
    }

    let groupId =  this.photoToDelete.groupId;
    this.photoToDelete = null;
    this.loader.display();
    this.toast.info(this.translationService.tr('remark.deleting_photo'));
    await this.remarkService.deletePhoto(this.remark.id, groupId);
  }

  async subscribeRemarkResolved() {
    return await this.eventAggregator
      .subscribe('remark:resolved', async message => {
        if (this.remark.id !== message.remarkId) {
          return;
        }
        this.state = 'resolved';
        this.remark.resolved = true;
        this.remark.resolver = {
          name: message.resolver,
          userId: message.resolverId
        };
        this.remark.resolvedAt = message.resolvedAt;
        if (this.account.userId !== this.remark.resolver.userId) {
          this.toast.success(this.translationService.tr('remark.remark_resolved'));
        }
      });
  }

  async subscribeRemarkDeleted() {
    return await this.eventAggregator
      .subscribe('remark:deleted', async message => {
        if (this.remark.id !== message.remarkId) {
          return;
        }
        if (this.account.userId !== this.remark.author.userId) {
          this.toast.info(this.translationService.tr('remark.remark_removed_by_author'));
          this.router.navigateToRoute('remarks');
        }
      });
  }

  async subscribeRemarkVoteSubmitted() {
    return await this.eventAggregator
      .subscribe('remark:vote_submitted', async message => {
        if (this.remark.id !== message.remarkId) {
          return;
        }
        if (Array.isArray(this.remark.votes)) {
          let index = this.remark.votes.findIndex(x => x.userId === message.userId);
          if (index < 0) {
            this.remark.votes.push({
              userId: message.userId,
              positive: message.positive,
              createdAt: message.createdAt
            });
          } else if (this.remark.votes[index].positive !== message.positive) {
            this.remark.votes[index].positive = message.positive;
          }
          if (this.account.userId !== message.userId) {
            this.calculateRating();
          }
        }
      });
  }

  async subscribeRemarkVoteDeleted() {
    return await this.eventAggregator
      .subscribe('remark:vote_deleted', async message => {
        if (Array.isArray(this.remark.votes)) {
          if (this.remark.id !== message.remarkId) {
            return;
          }
          let index = this.remark.votes.findIndex(x => x.userId === message.userId);
          if (index < 0) {
            return;
          }
          this.remark.votes.splice(index, 1);
          if (this.account.userId !== message.userId) {
            this.calculateRating();
          }
        }
      });
  }

  calculateRating() {
    if (Array.isArray(this.remark.votes)) {
      let rating = 0;
      this.remark.votes.forEach(x => {
        if (x.positive) {
          rating++;
        } else {
          rating--;
        }
      });
      this.rating = rating;
    }
  }

  async votePositive() {
    this._vote(true);
  }

  async voteNegative() {
    this._vote(false);
  }

  async _vote(positive) {
    this.sending = true;
    this.isPositiveVote = positive;
    await this.remarkService.vote(this.id, positive);
    this._changeVoteType(this.isPositiveVote);
    this.sending = false;
  }

  async deleteVote() {
    this.sending = true;
    await this.remarkService.deleteVote(this.id);
    if(this.vote.positive) {
      this.positiveVotes--;
    } else{
      this.negativeVotes--;
    } 
    this.vote = null;
    this.sending = false;
  }

  _changeVoteType(positive) {
    if(positive) {
      this.positiveVotes++;
    } else{
      this.negativeVotes++;
    }
    if (!this.hasVoted) {
      this.vote = {
        userId: this.account.userId,
        positive: positive
      };
      return; 
    }

    this.vote.positive = positive;
    if(positive) {
      this.negativeVotes--;
    } else{
      this.positiveVotes--;
    } 
  }

  handleRemarkResolved(operation) {
    this.toast.success(this.translationService.tr('remark.remark_resolved'));
    this.remark.resolved = true;
    this.loader.hide();
    this.sending = false;
    this.remark.state.state = 'resolved';
    this.activitiesCount++;
    this.router.navigateToRoute('remarks');
  }

  handleRemarkRenewed(operation) {
    this.toast.success(this.translationService.tr('remark.remark_renewed'));
    this.remark.resolved = false;
    this.loader.hide();
    this.sending = false;
    this.activitiesCount++;
    this.remark.state.state = 'renewed';
  }

  handleRemarkCanceled(operation) {
    this.toast.success(this.translationService.tr('remark.remark_canceled'));
    this.loader.hide();
    this.router.navigateToRoute('remarks');
  }

  handleRemarkDeleted(operation) {
    this.toast.success(this.translationService.tr('remark.remark_removed'));
    this.loader.hide();
    this.router.navigateToRoute('remarks');
  }

  handleRemarkReported(operation) {
    this.toast.success(this.translationService.tr('remark.report_sent'));
    this.loader.hide();
    this.sending = false;
    this.remark.reportsCount++;
  }

  async handlePhotosAddedToRemark(operation) {
    this.loader.hide();
    this.sending = false; 
    this.remark.status = null;
  }

  async handlePhotosFromRemarkRemoved(operation) {
    this.loader.hide();
    this.sending = false;
    this.remark.status = null;
    await this.toast.success(this.translationService.tr('remark.deleted_photo'));
  }

  async handleRemovePhotosFromRemarkRejected(operation) {
    this.toast.error(this.translationService.trCode(operation.code));
    let remark = await this.remarkService.getRemark(this.id);
    this.processPhotos(remark);
    this.sending = false;
    this.loader.hide();
  }

  handleRemarkVoteSubmitted(operation) {
    this.toast.success(this.translationService.tr('remark.vote_submitted'));
  }

  handleRemarkVoteDeleted(operation) {
    this.toast.success(this.translationService.tr('remark.vote_deleted'));
  }

  handleRejectedOperation(operation) {
    this.toast.error(this.translationService.trCode(operation.code));
    this.sending = false;
    this.loader.hide();
  }

  async process() {
    await this.remarkService.processRemark(this.id, this.processDescription);
  }

  handleRemarkProcessed(operation) {
    let description = this.processDescription;
    this.toast.success(this.translationService.tr('remark.activity_sent'));
    this.processDescription = '';
    this.activitiesCount++;
    this.remark.state.state = 'processing';
    this._setLatestActivity(description);
  }

  scrollToTop() {
    window.scrollTo(0, 0);
  }
}
